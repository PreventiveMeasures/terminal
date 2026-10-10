// An LALR(1) parse-table builder that makes the choices GNU Bison makes, so
// that a parser driven by these tables stops where gawk's own parser stops.
//
// What a program's mistakes look like to gawk depends on more than which
// programs its grammar accepts. It prints the first syntax error it meets
// and exits, and what it has printed by then — `BEGIN blocks must have an
// action part`, a `break` outside a loop, a warning about an escape — comes
// from the grammar's actions and its lexer, which run in the order Bison's
// tables have them run: a reduction made without reading the next token, or
// only after reading it. The lexer also reads differently by what the parser
// has just reduced (a `/` starts a regex only once the grammar says one may
// start there). So the tables here follow Bison's construction exactly:
//
// - LALR(1) lookaheads, from the LR(0) automaton by lookahead propagation.
// - Shift/reduce conflicts settled by precedence where both the rule and the
//   token have one (`%left`, `%right`, `%nonassoc`; a rule's precedence is its
//   `%prec` token's, or else that of the last token it mentions), and by
//   shifting otherwise. Reduce/reduce conflicts go to the earlier rule.
// - A default reduction in every state that has a reduction and no shift of
//   `error`: the one rule that is all a "consistent" state can do, or else
//   the rule most lookahead tokens reduce by. A state whose every token takes
//   the default does not read a token before reducing.
//
// The grammar is { rules: [{ lhs, rhs: [...symbols], prec }], precedence:
// [[assoc, ...tokens], lowest first], start }. Symbols that appear as a
// rule's left side are nonterminals, every other symbol a token, and `error`
// is the token Bison's error recovery shifts (gawk's yyerror() exits first,
// so recovery never runs, but a state that could shift `error` has no
// default reduction, which decides when lookaheads are read).
//
// The tables: `actions[state]` maps a token number to a shift (the target
// state, >= 0), a reduction (-1 - rule) or ERROR; a token it does not map
// takes `defaults[state]` (a rule, or -1 for a syntax error), and a state
// marked `defaultOnly` reduces by its default without reading a token.
// `gotos[state]` maps a nonterminal number (0 for $accept) to a state. Rule 0
// is `$accept: start $end`; the grammar's rules follow, numbered from 1.

export const ERROR = -0x7fffffff
const END = '$end'
const ACCEPT = '$accept'

// Token sets as bit arrays, one bit per token plus one for the stand-in
// lookahead the propagation pass threads through closures.
const hasBit = (set, i) => (set[i >>> 5] & (1 << (i & 31))) !== 0
const addBit = (set, i) => { set[i >>> 5] |= 1 << (i & 31) }
const dropBit = (set, i) => { set[i >>> 5] &= ~(1 << (i & 31)) }
function orInto(target, source) {
  let changed = false
  for (let w = 0; w < target.length; w++) {
    const before = target[w]
    target[w] |= source[w]
    if (target[w] !== before) changed = true
  }
  return changed
}

export function buildTables(grammar) {
  const g = compileGrammar(grammar)
  const states = lr0States(g)
  const la = lookaheads(g, states)
  const tables = {
    tokens: g.tokens,
    tokenIndex: g.tokenIndex,
    nonterminals: g.nonterminals,
    rules: g.rules.map((r) => ({ lhs: r.lhs - g.T, length: r.rhs.length })),
    actions: [],
    defaults: new Int32Array(states.length),
    defaultOnly: new Uint8Array(states.length),
    gotos: [],
    final: states[states[0].trans.get(g.index.get(grammar.start))].trans.get(0),
  }
  states.forEach((state, s) => {
    const row = actionRow(g, state, la[s])
    tables.actions.push(row.actions)
    tables.defaults[s] = row.defaultRule
    tables.defaultOnly[s] = row.actions.size === 0 && row.defaultRule >= 0 ? 1 : 0
    const gotos = new Map()
    for (const [sym, target] of state.trans) if (sym >= g.T) gotos.set(sym - g.T, target)
    tables.gotos.push(gotos)
  })
  return tables
}

// Symbols numbered tokens first ($end 0, error 1), then nonterminals
// ($accept first); rules as symbol numbers with their precedence; items
// (a rule and a position in it) numbered rule by rule; and the FIRST sets
// and nullability the closures need.
function compileGrammar(grammar) {
  const nonterminals = [ACCEPT, ...new Set(grammar.rules.map((r) => r.lhs))]
  const isNonterminal = new Set(nonterminals)
  const tokens = [END, 'error']
  const seen = new Set(tokens)
  const note = (s) => { if (!isNonterminal.has(s) && !seen.has(s)) { seen.add(s); tokens.push(s) } }
  for (const r of grammar.rules) r.rhs.forEach(note)
  for (const [, ...names] of grammar.precedence) names.forEach(note)
  const T = tokens.length
  const index = new Map([...tokens, ...nonterminals].map((s, i) => [s, i]))
  const level = new Int32Array(T)
  const assoc = []
  grammar.precedence.forEach(([kind, ...names], i) => {
    for (const name of names) { level[index.get(name)] = i + 1; assoc[index.get(name)] = kind }
  })
  const rules = [{ lhs: ACCEPT, rhs: [grammar.start, END], prec: null }, ...grammar.rules].map((r) => {
    const rhs = r.rhs.map((s) => index.get(s))
    const last = rhs.findLast((s) => s < T)
    const prec = r.prec === null ? (last === undefined ? 0 : level[last]) : level[index.get(r.prec)]
    return { lhs: index.get(r.lhs), rhs, prec }
  })
  const g = {
    tokens, tokenIndex: new Map(tokens.map((t, i) => [t, i])), nonterminals, index, T, rules, level, assoc,
    W: (T >>> 5) + 1, rulesFor: nonterminals.map(() => []), itemRule: [], itemDot: [],
  }
  g.firstItem = rules.map((r, ri) => {
    g.rulesFor[r.lhs - T].push(ri)
    const first = g.itemRule.length
    for (let d = 0; d <= r.rhs.length; d++) { g.itemRule.push(ri); g.itemDot.push(d) }
    return first
  })
  g.nextSym = Int32Array.from(g.itemRule, (ri, item) => rules[ri].rhs[g.itemDot[item]] ?? -1)
  g.next = (item) => g.nextSym[item]
  firstSets(g)
  g.closures = nonterminalClosures(g)
  return g
}

function firstSets(g) {
  const { T, rules, W } = g
  const nullable = new Uint8Array(g.nonterminals.length)
  const first = g.nonterminals.map(() => new Uint32Array(W))
  for (let changed = true; changed;) {
    changed = false
    for (const r of rules) if (firstPass(g, r, first, nullable)) changed = true
  }
  // FIRST of what follows an item's next symbol, and whether it can vanish.
  g.restFirst = []
  g.restNullable = new Uint8Array(g.itemRule.length)
  for (let item = 0; item < g.itemRule.length; item++) {
    const rhs = rules[g.itemRule[item]].rhs
    const set = new Uint32Array(W)
    let vanish = 1
    for (let d = g.itemDot[item] + 1; d < rhs.length && vanish; d++) {
      const s = rhs[d]
      if (s < T) { addBit(set, s); vanish = 0 } else { orInto(set, first[s - T]); vanish = nullable[s - T] }
    }
    g.restFirst.push(set)
    g.restNullable[item] = vanish
  }
}

// What a rule's right side can start with goes into its left side's FIRST
// set, and the left side can vanish if all of the right side can; true
// when either grew.
function firstPass(g, r, first, nullable) {
  const set = first[r.lhs - g.T]
  let changed = false
  let vanishes = true
  for (const s of r.rhs) {
    if (s < g.T) {
      if (!hasBit(set, s)) changed = true
      addBit(set, s)
      vanishes = false
      break
    }
    if (orInto(set, first[s - g.T])) changed = true
    if (!nullable[s - g.T]) { vanishes = false; break }
  }
  if (vanishes && !nullable[r.lhs - g.T]) { nullable[r.lhs - g.T] = 1; changed = true }
  return changed
}

// The LR(0) automaton, states numbered as Bison numbers them: in the order
// they are first reached, each state's transitions taken by symbol number.
// A state's items are its kernel and what closing over the nonterminals
// after the kernel's dots brings in.
function lr0States(g) {
  const states = [{ kernel: [g.firstItem[0]] }]
  const byKernel = new Map([[String(g.firstItem[0]), 0]])
  const stamp = new Int32Array(g.itemRule.length).fill(-1)
  for (let s = 0; s < states.length; s++) {
    const state = states[s]
    const items = [...state.kernel]
    for (const item of items) stamp[item] = s
    for (const item of state.kernel) {
      const x = g.nextSym[item]
      if (x < g.T) continue
      for (const entry of g.closures[x - g.T]) {
        if (stamp[entry.item] !== s) { stamp[entry.item] = s; items.push(entry.item) }
      }
    }
    items.sort((a, b) => a - b)
    state.items = items
    const groups = new Map()
    for (const item of items) {
      const x = g.nextSym[item]
      if (x < 0) continue
      const group = groups.get(x)
      if (group === undefined) groups.set(x, [item + 1])
      else group.push(item + 1)
    }
    state.trans = new Map()
    for (const x of [...groups.keys()].sort((a, b) => a - b)) {
      const kernel = groups.get(x)
      const key = kernel.join(',')
      let target = byKernel.get(key)
      if (target === undefined) {
        target = states.length
        states.push({ kernel })
        byKernel.set(key, target)
      }
      state.trans.set(x, target)
    }
  }
  return states
}

// What closing over a nonterminal B adds to a state, the same in every
// state: each item it brings in, the lookaheads it gets from within the
// closure (`own`), and whether it also gets those of B's context
// (`inherits`) — whatever may follow B in the item that brought it in.
// Every rule of a nonterminal comes in with the same lookaheads, which
// flow from a rule `A: C ...` to C: what may follow C there, and A's own
// lookaheads when that may be nothing.
function nonterminalClosures(g) {
  const dummy = g.T
  const corners = g.nonterminals.map(() => [])
  g.rules.forEach((r, ri) => {
    const x = r.rhs[0]
    if (x !== undefined && x >= g.T) corners[r.lhs - g.T].push({ to: x - g.T, item: g.firstItem[ri] })
  })
  return g.rulesFor.map((unused, b) => {
    const sets = g.nonterminals.map(() => null)
    const order = [b]
    sets[b] = new Uint32Array(g.W)
    addBit(sets[b], dummy)
    const work = [b]
    while (work.length > 0) {
      const a = work.pop()
      for (const { to, item } of corners[a]) {
        if (sets[to] === null) { sets[to] = new Uint32Array(g.W); order.push(to) }
        const grew = orInto(sets[to], g.restFirst[item])
        if ((g.restNullable[item] && orInto(sets[to], sets[a])) || grew) work.push(to)
      }
    }
    const entries = []
    for (const c of order) {
      const set = sets[c]
      const inherits = hasBit(set, dummy)
      dropBit(set, dummy)
      for (const r of g.rulesFor[c]) entries.push({ item: g.firstItem[r], own: set, inherits })
    }
    return entries
  })
}

// LALR(1) lookaheads of every state's kernel items, by propagation: a
// successor item gets some lookaheads outright, and inherits the rest from
// the kernel item it follows from, or from the kernel item whose closure
// brought its predecessor in when nothing after the nonterminal it closed
// over need be read. Kernel items are numbered across states here, and
// the result is a set per state per kernel item.
function lookaheads(g, states) {
  const base = new Int32Array(states.length + 1)
  states.forEach((state, s) => { base[s + 1] = base[s] + state.kernel.length })
  const la = Array.from({ length: base[states.length] }, () => new Uint32Array(g.W))
  const kernelAt = states.map((state) => new Map(state.kernel.map((item, k) => [item, k])))
  const from = []
  const to = []
  states.forEach((state, s) => {
    const successor = (item) => {
      const t = state.trans.get(g.nextSym[item])
      return base[t] + kernelAt[t].get(item + 1)
    }
    state.kernel.forEach((item, k) => {
      const x = g.nextSym[item]
      if (x < 0) return
      from.push(base[s] + k)
      to.push(successor(item))
      if (x < g.T) return
      const context = g.restFirst[item]
      const passes = g.restNullable[item] === 1
      for (const entry of g.closures[x - g.T]) {
        if (g.nextSym[entry.item] < 0) continue
        const target = successor(entry.item)
        orInto(la[target], entry.own)
        if (!entry.inherits) continue
        orInto(la[target], context)
        if (passes) { from.push(base[s] + k); to.push(target) }
      }
    })
  })
  for (let changed = true; changed;) {
    changed = false
    for (let i = 0; i < from.length; i++) if (orInto(la[to[i]], la[from[i]])) changed = true
  }
  return states.map((state, s) => la.slice(base[s], base[s + 1]))
}

// The lookaheads of a state's completed items: its kernel items' own, and
// for an empty rule closed in, what its closure entries give it.
function completedLookaheads(g, state, kernelLa) {
  const sets = new Map()
  const at = (item) => {
    if (!sets.has(item)) sets.set(item, new Uint32Array(g.W))
    return sets.get(item)
  }
  state.kernel.forEach((item, k) => {
    const x = g.nextSym[item]
    if (x < 0) { orInto(at(item), kernelLa[k]); return }
    if (x < g.T) return
    for (const entry of g.closures[x - g.T]) {
      if (g.nextSym[entry.item] >= 0) continue
      const set = at(entry.item)
      orInto(set, entry.own)
      if (!entry.inherits) continue
      orInto(set, g.restFirst[item])
      if (g.restNullable[item]) orInto(set, kernelLa[k])
    }
  })
  return sets
}

// One state's row of the action table, as Bison's tables.c fills it.
function actionRow(g, state, kernelLa) {
  const shifts = [...state.trans].filter(([x]) => x < g.T)
  const completed = state.items.filter((item) => g.next(item) < 0)
  const consistent = completed.length <= 1 && shifts.length === 0
  if (consistent) return { actions: new Map(), defaultRule: completed.length === 1 ? g.itemRule[completed[0]] : -1 }
  const sets = completedLookaheads(g, state, kernelLa)
  const reductions = completed.map((item) => ({ rule: g.itemRule[item], la: sets.get(item) })).sort((a, b) => a.rule - b.rule)
  const enabled = new Map(shifts)
  const errors = resolveConflicts(g, enabled, reductions)
  const actions = new Map()
  for (const { rule, la } of reductions.toReversed()) {
    for (let t = 0; t < g.T; t++) if (hasBit(la, t)) actions.set(t, -1 - rule)
  }
  for (const [t, target] of enabled) actions.set(t, target)
  for (const t of errors) actions.set(t, ERROR)
  let defaultRule = -1
  if (reductions.length > 0 && !state.trans.has(1)) {
    let max = 0
    for (const { rule } of reductions) {
      let count = 0
      for (const a of actions.values()) if (a === -1 - rule) count++
      if (count > max) { max = count; defaultRule = rule }
    }
    if (max > 0) for (const [t, a] of actions) if (a === -1 - defaultRule) actions.delete(t)
  }
  if (defaultRule < 0) for (const [t, a] of actions) if (a === ERROR) actions.delete(t)
  return { actions, defaultRule }
}

// Bison's precedence pass: for each reduction with a precedence, each token
// it could reduce on that the state could also shift, and that has a
// precedence itself, keeps the shift or the reduction (or neither, for
// %nonassoc: an explicit error). Returns the tokens made errors.
function resolveConflicts(g, enabled, reductions) {
  const shiftable = new Uint32Array(g.W)
  for (const t of enabled.keys()) addBit(shiftable, t)
  const errors = []
  for (const red of reductions) {
    const prec = g.rules[red.rule].prec
    if (prec === 0) continue
    for (let t = 0; t < g.T; t++) {
      if (!hasBit(shiftable, t) || !hasBit(red.la, t) || g.level[t] === 0) continue
      const kind = g.level[t] < prec ? 'left' : g.level[t] > prec ? 'right' : g.assoc[t]
      if (kind === 'right') { dropBit(red.la, t); continue }
      dropBit(shiftable, t)
      enabled.delete(t)
      if (kind === 'nonassoc') { dropBit(red.la, t); errors.push(t) }
    }
  }
  return errors
}
