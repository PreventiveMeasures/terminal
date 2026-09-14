// The short answer for a line: what it runs, in plain text, and nothing about
// how it was written. The tree is what reading a line gives; this is what a
// caller gets when the line stays simple enough to say outright.

import { read } from './parse-tree.js'

// A chain is what a line looks like when nothing in it needs explaining: the
// commands it runs, each stage's argv, each redirect as the tokens it was
// written with. Anything a summary would have to lie about — a block, a
// negation, an assignment, a word an expansion still decides — stops it, so a
// caller either gets the whole line in plain text or hears why it cannot.
//
// A gate stands between the chains it gates, since `&&` and `||` decide
// whether the next one runs at all. A `;` decides nothing, so it is the plain
// sequence the rows already are.
export function summarize(line, writable) {
  const result = read(line, writable)
  if (!result.ok) throw new Error(result.error)
  return summaryOf(result.list, { defined: new Map(), open: new Set() })
}

// What a list of commands looks like summarized, top level or inside a `( … )`
// — the same thing either way, since a subshell holds a list like any other.
function summaryOf(nodes, macros) {
  const summary = []
  for (const node of nodes) {
    // A definition runs nothing, so a summary of what runs says nothing about
    // it; the body stands where it is called instead.
    if (node.type === 'function') {
      if (node.op === '&&' || node.op === '||') throw refuse('a function defined behind a gate')
      macros.defined.set(node.name, node.list)
      continue
    }
    if (node.op === '&&' || node.op === '||') summary.push(node.op)
    summary.push(chainOf(node, macros))
    if (node.background) summary.push('&')
  }
  return summary
}

// A call is the body it names, standing where the call stands — which is all
// a body that reads nothing of its caller can be. A body of one command reads
// as that command, since brackets that keep nothing in come off. A body that
// reaches its own name has no end to stand in for, so it is refused, as
// running one is.
function inlined(stage, macros, depth = 0) {
  if (stage.type !== 'command' || typeof stage.argv[0] !== 'string') return opened(stage)
  const list = macros.defined.get(stage.argv[0])
  if (list === undefined) return opened(stage)
  if (depth > 16 || macros.open.has(stage.argv[0])) throw refuse('a function that calls itself')
  const call = { type: 'group', name: stage.argv[0], list, redirects: stage.redirects, assignments: stage.assignments }
  return inlined(opened(call), macros, depth + 1)
}

const BLOCKS = { if: '`if`', test: '`[[ … ]]`', pipeline: 'a pipeline of pipelines' }

// What a chain's rows can be: a command, and the two blocks that are a list of
// commands and nothing a summary would have to leave out.
const ROWS = new Set(['command', 'subshell', 'group', 'for', 'while', 'until'])

function chainOf(node, macros) {
  if (node.negate) throw refuse('`!`')
  const stages = node.type === 'pipeline' ? node.stages : [node]
  const chain = []
  let commands = 0
  for (const [index, written] of stages.entries()) {
    const stage = inlined(written, macros)
    if (!ROWS.has(stage.type)) throw refuse(BLOCKS[stage.type])
    if (stage.type === 'command' && stage.argv.length === 0 && !stage.assignments) throw refuse('a command with no name')
    const redirects = stage.redirects ?? []
    const input = inputOf(redirects, index)
    if (input) { chain.push(inputStage(input, macros)); commands++ }
    const row = rowOf(stage, macros)
    // A `cat` with no file of its own hands its input straight on, so once
    // something is feeding the chain it says nothing: `echo x | cat > f` is
    // `echo x > f`, and its own redirects stay where they were.
    if (!passthrough(row, commands)) { chain.push(row); commands++ }
    for (const redirect of redirects) {
      if (redirect !== input) chain.push(redirectTokens(redirect, macros))
    }
  }
  return chain
}

// A command is its words; the blocks that are a list of commands are that
// list, summarized as a line of its own, with whatever the block says about
// how it runs one — a `for` says which name it runs the list over, and what
// it gives that name in turn. `( … )` and `{ …; }` are told apart by the
// brackets they were written with, which is the whole of the difference: one
// keeps what it runs to itself, and the other does not.
function rowOf(stage, macros) {
  if (stage.type === 'subshell') return { type: 'parens', summary: summaryOf(stage.list, macros) }
  if (stage.type === 'group') return { type: 'braces', summary: body(stage, macros) }
  if (stage.type === 'for') return { type: 'for', name: stage.name, words: stage.words.map((word) => literal(word, macros)), summary: summaryOf(stage.list, macros) }
  if (stage.type === 'while' || stage.type === 'until') return { type: stage.type, condition: summaryOf(stage.condition, macros), summary: summaryOf(stage.list, macros) }
  if (stage.assignments && stage.argv === undefined) throw refuse('an assignment on a call of more than one command')
  const argv = stage.argv.map((word) => literal(word, macros))
  if (stage.assignments) argv.unshift(assignmentsOf(stage.assignments, macros))
  return argv
}

// The body of a call, with its own name held open: reaching that name again
// is reaching a body with no end, which no summary can stand in for.
function body(stage, macros) {
  if (stage.name === undefined) return summaryOf(stage.list, macros)
  macros.open.add(stage.name)
  try { return summaryOf(stage.list, macros) } finally { macros.open.delete(stage.name) }
}

// `( ls )` and `{ ls; }` run what `ls` runs. Brackets around one command say
// nothing the command does not, with one exception: parentheses keep a
// command's directory, its variables and its exit from reaching the shell
// around them, so those keep theirs. Redirects on both sides belong to
// neither pair: `(ls > a) > b` writes to `a` and leaves `b` empty, where
// `ls > a > b` would leave `a` empty instead.
function opened(stage) {
  if ((stage.type !== 'subshell' && stage.type !== 'group') || stage.list.length !== 1) return stage
  const [inner] = stage.list
  if (inner.type !== 'command' || inner.negate || inner.background) return stage
  if (stage.type === 'subshell' && (inner.assignments || typeof inner.argv[0] !== 'string' || OUTLIVES.has(inner.argv[0]))) return stage
  if ((stage.redirects ?? []).length > 0 && (inner.redirects ?? []).length > 0) return stage
  if (stage.assignments && inner.assignments) return stage
  return {
    ...inner,
    ...(stage.assignments || inner.assignments ? { assignments: stage.assignments ?? inner.assignments } : {}),
    redirects: [...(inner.redirects ?? []), ...(stage.redirects ?? [])],
  }
}

// What a command can change that outlives it: the shell's directory, its
// variables, its options, whether it is still running at all. Bash keeps the
// list, so a name on it keeps its parentheses whether this terminal runs it
// or refuses it.
const OUTLIVES = new Set(['cd', 'pushd', 'popd', 'exit', 'exec', 'export', 'unset', 'set', 'shopt', 'shift', 'source', '.', 'eval', 'read', 'readonly', 'declare', 'typeset', 'local', 'alias', 'unalias', 'trap', 'umask', 'ulimit', 'let', 'return', 'break', 'continue', 'hash', 'getopts', 'disown', 'bind', 'enable'])

const passthrough = (row, commands) => commands > 0 && row.length === 1 && row[0] === 'cat'

// `A=1 B=2 cmd` sets those for that command alone and `A=1` on its own sets
// them for the shell, so they stand at the head of the row they were written
// at the head of — one token, since one command takes them all together, and
// a row's name is the first token that is not this one.
const assignmentsOf = (assignments, macros) => ({ type: 'assignments', assignments: assignments.map((a) => ({ name: a.name, value: literal(a.value, macros) })) })

// A summary says what a line does, not how it was spelled, so whatever feeds
// a command is the command that feeds it. Only the first stage can be fed that
// way — a later one reading its own input leaves the stage before it writing
// into nothing, which no chain says — and one stage reads from one place, so a
// second source has no equivalent either.
function inputOf(redirects, index) {
  const inputs = redirects.filter((r) => r.op === '<' || r.op === '<<' || r.op === '<<<')
  if (inputs.length === 0) return null
  if (index > 0) throw refuse('a pipeline stage reading its own input')
  if (inputs.length > 1) throw refuse('a command reading from two places')
  return inputs[0]
}

// A file is the `cat` that reads it: `wc < 1.txt` is `cat 1.txt | wc`. Text is
// the command that writes it: `cat > notes.md <<EOF … EOF` is
// `echo … | cat > notes.md`. An unquoted delimiter leaves the body to be
// expanded when it runs, which is not text anyone can write down yet.
function inputStage(redirect, macros) {
  if (redirect.op === '<') return ['cat', literal(redirect.target, macros)]
  if (redirect.op === '<<<') return hereStringStage(literal(redirect.text, macros))
  if (redirect.expand && /[$`\\]/u.test(redirect.text)) throw refuse('a here-document its delimiter leaves to expand')
  return textStage(redirect.text)
}

// A here-string is its word and a newline. Where only running the line settles
// the word, `printf` says it exactly, whatever it turns out to be.
const hereStringStage = (text) => (typeof text === 'string' ? textStage(`${text}\n`) : ['printf', '%s\\n', text])

// `echo` writes its argument and a newline, which is how a here-document ends,
// so the body gives one up to it. Where echo would say something else — a body
// that ends without one, or a first word it would read as an option — `printf`
// says it exactly.
function textStage(text) {
  const line = text.endsWith('\n') ? text.slice(0, -1) : null
  return line !== null && !line.startsWith('-') ? ['echo', line] : ['printf', '%s', text]
}

// The operator as it was typed, with the descriptor it defaults to left off.
function redirectTokens(redirect, macros) {
  const { fd, op } = redirect
  const lead = op.startsWith('&') || fd === 1 ? '' : String(fd)
  if (op === '>&') return [`${lead}>&${redirect.toFd}`]
  if (op === '>&-') return [`${lead}>&-`]
  return [lead + op, literal(redirect.target, macros)]
}

// A token is the text it will be, or what stands in for it, or the word those
// are joined into. Each says what it reaches for as plainly as a name says
// what it runs.
const literal = (value, macros) => {
  if (typeof value === 'string') return value
  const text = literalText(value)
  if (text !== null) return text
  return value.type === 'parts' ? { type: 'parts', parts: value.parts.map((part) => piece(part, macros)) } : piece(value, macros)
}

// A pattern, a variable, or the shell a word waits on. Arithmetic is a sum
// nobody has added up, and a brace group left unexpanded is more words than
// the one slot it sits in takes, so neither is a word to say outright.
function piece(part, macros) {
  if (typeof part === 'string' || part.type === 'pattern') return part
  // `${x:-$(id)}` runs `id`, and the operand it runs it in is text here, as
  // the line wrote it. A summary saying only `${x:-$(id)}` would have hidden
  // a command inside a string, so text is all an operand may hold.
  if (part.type === 'variable') {
    if (RUNS.test(part.operand ?? '')) throw refuse(spell(part), 'a literal word')
    return part
  }
  if (part.type === 'process') return { type: 'process', op: part.op, summary: summaryOf(part.list, macros) }
  // A sum is an expression rather than a list of commands, so a summary says
  // it as the line wrote it — and as with an operand, text is all it may
  // hold: `$(( $(id -u) ))` would be running one behind a reader.
  if (part.type === 'arithmetic') {
    if (RUNS.test(part.source)) throw refuse(spell(part), 'a literal word')
    return part
  }
  if (part.type !== 'substitution') throw refuse(spell(part), 'a literal word')
  // Bash parses a backtick when it comes to run it, so a body that does not
  // parse is a line that does not parse, reported as any other one is.
  if (part.error) throw new Error(part.error)
  return { type: 'shell', summary: summaryOf(part.list, macros), multi: part.multi }
}

// `"$(cat <<'EOF' … EOF)"` is the text it holds and nothing else: a literal
// here-document, cat, and the trailing newlines `$( )` strips. Every part has
// to be quoted for that to hold — bare, the text would be split into fields
// and globbed, and no single token would stand for it.
function literalText(value) {
  let text = ''
  for (const part of value.type === 'parts' ? value.parts : [value]) {
    if (typeof part === 'string') { text += part; continue }
    if (part.multi) return null
    const here = heredocText(part)
    if (here === null) return null
    text += here
  }
  return text
}

function heredocText(part) {
  if (part.type !== 'substitution' || part.list.length !== 1) return null
  const [node] = part.list
  if (node.type !== 'command' || node.negate || node.assignments) return null
  if (node.argv.length !== 1 || node.argv[0] !== 'cat') return null
  const [redirect, ...rest] = node.redirects ?? []
  if (rest.length > 0 || redirect?.op !== '<<' || redirect.expand) return null
  return redirect.text.replace(/\n+$/u, '')
}

// Name the piece that needs expanding the way it was written.
const spell = (part) => {
  if (typeof part === 'string') return part
  if (part.type === 'pattern') return part.pattern
  if (part.type === 'brace') return part.source
  if (part.type === 'variable') return `\${${part.name}${part.operator ?? ''}${part.operand ?? ''}}`
  return part.type === 'arithmetic' ? '$((…))' : '$(…)'
}

// What no text says outright: a command whose output it will hold.
const RUNS = /\$\(|`/u

const refuse = (what, kind = 'a simple chain') => new Error(`summarize: ${what} is not ${kind}`)
