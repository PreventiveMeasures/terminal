// Split a tokenized command line (see tokenize.js) into a sequence of
// pipeline steps with short-circuit gates (`&&` / `||`) between them. Each
// step is a list of stages connected by `|`; each stage carries
// its argv plus optional stdout/stderr suppression flags, OR
// (for a subshell stage) a nested `group` of inner steps, OR (for a
// `for` loop) a `loop` — its variable name, word list and body.
//
// Recognized boundary tokens (the tokenizer itself lives in
// tokenize.js):
//   `|`       — pipe to the next stage in the current step
//   `;`       — sequential run; next step runs regardless of the
//               previous step's exit code (the unconditional sibling
//               of `&&` / `||`)
//   newline   — an unquoted newline (`\n`) ends the current command
//               and separates it from the next, exactly like `;` (a
//               pasted multi-line block runs line by line). Blank
//               lines and leading/trailing breaks are no-ops; a
//               newline right after `|` / `&&` / `||` / `(` is absorbed
//               so the command continues on the next line. A newline
//               inside quotes stays literal.
//   `&&`      — run next step only if current step exited 0
//   `||`      — run next step only if current step exited non-zero
//   `(` `)`   — subshell grouping. The contents parse as their own
//               step list and run with an isolated cwd (so `cd`
//               inside `()` doesn't leak out). The group itself
//               occupies one stage slot and can be piped, gated,
//               and redirected like any other stage.
//   `for` … `done`
//             — a `for NAME in WORD…; do LIST; done` loop. `for`, `do`
//               and `done` are reserved words in command position only
//               (`echo done` prints `done`). Like a subshell the loop
//               occupies one stage slot and can be piped, gated and
//               redirected; unlike one it shares the outer cwd. The
//               body parses as its own step list. The word list is
//               kept unexpanded — index.js expands it, and substitutes
//               the `$NAME` references tokenize.js marks in the body,
//               when the loop runs. No `break` / `continue`, no
//               `while` / `if` / `case`.
//   `>` / `1>` — redirect stdout; only `/dev/null` is allowed as
//               the target (the virtual FS is read-only) and means
//               "discard"
//   `2>`      — redirect stderr; same `/dev/null`-only restriction
//   `2>&1`    — merge stderr into stdout (and the symmetric `1>&2`,
//               plus `>&2` / `>&1` with the fd left implicit, as bash
//               allows). Applied before `/dev/null` sinks, so
//               `>/dev/null 2>&1` silences both streams.
//   `>>` / `1>>` / `2>>` — append form, rejected outright
//
// Boundary tokens are tagged by `kind`, not by string value, so a
// quoted `"|"` / `">"` / `"("` — or `"for"` — stays an ordinary word.

import { NAME_RE, tokenize } from './tokenize.js'

import { UnsupportedError } from './unsupported.js'

export function parseLine(line) {
  const raw = tokenize(line)
  for (const t of raw) {
    if (t.kind === 'amp') throw new UnsupportedError('feature', '&', 'background processes (`&`) are not supported')
  }
  // Trailing `;` is a no-op in bash; tolerate it so `cmd1; cmd2;`
  // doesn't trip the empty-stage check below. We don't extend the
  // same forgiveness to trailing `&&` / `||` because those would
  // wait for continuation in bash — without a continuation prompt,
  // erroring is the better signal.
  while (raw.length > 0 && raw.at(-1).kind === 'semi') raw.pop()
  const { steps, consumed } = buildSteps(raw, 0, null)
  if (consumed !== raw.length) throw new Error('unexpected `)`')
  validateSteps(steps)
  return steps
}

// A "group stage" carries no argv — its content is the nested
// `steps`; a "loop stage" likewise carries its content in `loop.body`.
// Their argv is unreachable, but checking `.group` / `.loop` first
// lets the same validator handle every shape.
function validateSteps(steps) {
  for (const step of steps) {
    if (step.stages.length === 0) throw new Error('empty pipeline stage')
    for (const s of step.stages) {
      if (s.group) validateSteps(s.group)
      else if (s.loop) validateSteps(s.loop.body)
      else if (s.argv.length === 0) throw new Error('empty pipeline stage')
    }
  }
}

// A stage's word list: argv plus the per-index side tables the
// expanders need — `quoted` (indices to leave literal) and `refs`
// (indices carrying `$NAME` references, mapped to the tokenizer's
// literal/reference split of that word). A `for` loop's word list is
// stored in the same shape (see parseFor).
const newStage = () => ({ argv: [], quoted: new Set(), refs: new Map() })

function pushWord(stage, t) {
  if (t.quoted) stage.quoted.add(stage.argv.length)
  if (t.parts) stage.refs.set(stage.argv.length, t.parts)
  stage.argv.push(t.value)
}

// Nothing has been attached to the stage yet, so the next word names
// a command — the one place the reserved words and `(` are recognized.
// Redirects don't count: `>/dev/null (echo a)` and `2>/dev/null for …`
// attach a leading redirect to the group or loop that follows.
const commandPosition = (stage) => !stage.group && !stage.loop && stage.argv.length === 0

// Reserved words, recognized unquoted and in command position only.
// `in` is not among them — bash reserves it too, but here it only
// matters right after `for NAME`, where parseFor looks for it.
const KEYWORDS = new Set(['for', 'do', 'done'])

// Recursive: `end` names the token that closes the block being parsed
// — `)` inside a `(...)` group, `done` inside a `for` body, `null` at
// top level. The returned `consumed` index points one past the closing
// token (or one past the last token at top level), letting the caller
// resume from there.
function buildSteps(raw, start, end) {
  const steps = [{ gate: 'first', stages: [] }]
  let stage = newStage()
  let i = start
  while (i < raw.length) {
    const t = raw[i]
    if (t.kind === 'paren_close') {
      if (end !== ')') throw new Error('unexpected `)`')
      return finishBlock(steps, stage, i + 1, 'empty subshell `()`')
    }
    if (t.kind === 'paren_open') {
      // A subshell occupies a whole stage slot. Allowing tokens to
      // accumulate before it (`echo a (cmd)`) would create an argv
      // + group hybrid with no sensible semantics, so error early.
      if (!commandPosition(stage)) throw new Error('unexpected `(`')
      const inner = buildSteps(raw, i + 1, ')')
      // Mutate (not replace) the in-flight stage so leading redirects
      // attach to the group: `>/dev/null (echo a)` carries a
      // stdoutToNull flag set by the earlier applyRedir, and we
      // want it to silence the group's output.
      stage.group = inner.steps
      i = inner.consumed
      continue
    }
    if (t.kind === 'pipe' || t.kind === 'and' || t.kind === 'or' || t.kind === 'semi') {
      steps.at(-1).stages.push(stage)
      stage = newStage()
      if (t.kind === 'and') steps.push({ gate: 'and', stages: [] })
      else if (t.kind === 'or') steps.push({ gate: 'or', stages: [] })
      else if (t.kind === 'semi') steps.push({ gate: 'seq', stages: [] })
      i++
      continue
    }
    if (t.kind === 'redir') { i = applyRedir(stage, raw, i) + 1; continue }
    // After a closing `)` / `done` the only legal continuations are a
    // boundary token (handled above) or a redirect for the group or
    // loop itself (also above). Stray words like `(echo a) hi` land here.
    if (stage.group) throw new Error('unexpected token after `)`')
    if (stage.loop) throw new Error('unexpected token after `done`')
    if (!t.quoted && commandPosition(stage) && KEYWORDS.has(t.value)) {
      if (t.value === 'done' && end === 'done') return finishBlock(steps, stage, i + 1, 'for: empty loop body')
      // `do` anywhere but in a `for` header, `done` with no loop open.
      if (t.value !== 'for') throw new Error(`unexpected \`${t.value}\``)
      const loop = parseFor(raw, i + 1)
      // Mutated, not replaced, for the same leading-redirect reason
      // as the group above.
      stage.loop = loop.loop
      i = loop.consumed
      continue
    }
    pushWord(stage, t)
    i++
  }
  if (end === ')') throw new Error('unmatched `(`')
  if (end === 'done') throw new Error('for: missing `done`')
  steps.at(-1).stages.push(stage)
  return { steps, consumed: i }
}

// The `for` header, starting just past the keyword: NAME, `in`, the
// word list up to a `;` (or newline), then `do`, then the body up to
// `done`. Stricter than bash in one place — `for f; do …; done`, which
// iterates the positional parameters, is rejected outright since there
// are none to iterate — and more lenient in one: a `;` right after `do`
// is accepted where bash allows only a newline, because the tokenizer
// has already turned newlines into `;`. Exactly one separator is
// skipped at each boundary, so `;;` is an error here as in bash.
function parseFor(raw, start) {
  let i = start
  const nameTok = raw[i]
  if (nameTok === undefined || nameTok.kind !== 'word') throw new Error('for: expected a variable name')
  const name = nameTok.value
  if (nameTok.quoted || !NAME_RE.test(name)) throw new Error(`for: \`${name}\` is not a valid variable name`)
  i = skipSemi(raw, i + 1)
  if (!isWord(raw[i], 'in')) throw new Error(`for: expected \`in\` after \`${name}\``)
  i++
  // The word list rides in a stage-shaped record with the keyword in
  // the command slot, so the expanders' argv[0] carve-out lines up:
  // index.js drops that slot after expanding.
  const words = newStage()
  words.argv.push('for')
  // `do` is an ordinary word here, as in bash (`for f in a do; do …`
  // iterates over `do` too); it is only remembered so the error can
  // name the likely cause when the real `do` turns out to be missing.
  let sawDo = false
  for (; i < raw.length && raw[i].kind !== 'semi'; i++) {
    const t = raw[i]
    if (t.kind !== 'word') throw new Error(`for: unexpected \`${tokenLabel(t)}\` in word list`)
    if (isWord(t, 'do')) sawDo = true
    pushWord(words, t)
  }
  i = skipSemi(raw, i)
  if (!isWord(raw[i], 'do')) {
    if (sawDo) throw new Error('for: expected `;` or newline before `do`')
    if (i >= raw.length) throw new Error('for: missing `do`')
    throw new Error(`for: expected \`do\`, got \`${tokenLabel(raw[i])}\``)
  }
  i = skipSemi(raw, i + 1)
  const body = buildSteps(raw, i, 'done')
  return { loop: { name, words, body: body.steps }, consumed: body.consumed }
}

// Index past one `;` at `i`, if there is one — a newline in the source.
function skipSemi(raw, i) {
  return raw[i]?.kind === 'semi' ? i + 1 : i
}

// The unquoted word `value`, as opposed to a quoted spelling of it.
function isWord(t, value) {
  return t !== undefined && t.kind === 'word' && !t.quoted && t.value === value
}

// The token as the user would have typed it, for error messages. A
// quoted word keeps its quotes, so a `"do"` that failed to be the
// keyword is not reported as `do`.
const LABELS = { semi: ';', pipe: '|', and: '&&', or: '||', amp: '&', paren_open: '(', paren_close: ')' }
function tokenLabel(t) {
  if (t.kind === 'word') return t.quoted ? `"${t.value}"` : t.value
  if (t.kind === 'redir') return (t.fd === '1' ? '' : t.fd) + '>' + (t.toFd ? '&' + t.toFd : t.append ? '>' : '')
  return LABELS[t.kind]
}

// Close out a `(...)` group or a `for` body. Two cases need care:
//   - `()` / `do done` — a truly empty block, distinct error from the
//     generic "empty pipeline stage" so the user sees what they did
//     wrong.
//   - `(echo a;)` / `echo a; done` — trailing `;` before the closer,
//     mirroring the top-level trailing-semi tolerance. The semi already
//     pushed an empty new step; drop it here. Only a `;` earns this: a
//     dangling `&&` / `||` before the closer keeps its empty step for
//     the validator to reject, as `cat x &&` is rejected at top level.
// "Empty" excludes redirects: `(>/dev/null)` and `(echo a; >/dev/null)`
// must NOT silently drop the redirect — they fall through to the
// regular validator and surface as "empty pipeline stage".
function finishBlock(steps, stage, consumed, emptyError) {
  const lastStep = steps.at(-1)
  const emptyTail = commandPosition(stage) && !hasRedirects(stage) && lastStep.stages.length === 0
  if (emptyTail && steps.length === 1) throw new Error(emptyError)
  if (emptyTail && lastStep.gate === 'seq') steps.pop()
  else lastStep.stages.push(stage)
  return { steps, consumed }
}

function hasRedirects(stage) {
  return Boolean(stage.stdoutToNull || stage.stderrToNull
    || stage.mergeStderrToStdout || stage.mergeStdoutToStderr)
}

function applyRedir(stage, raw, i) {
  const op = raw[i]
  // Format the operator how the user would have typed it: bare `>`
  // / `>>` for stdout (fd=1 implied), `2>` / `2>>` for stderr.
  // Avoids confusing messages like "redirect `1>` requires a
  // target" when the user typed plain `>`.
  const prefix = op.fd === '1' ? '' : op.fd
  // Fd-to-fd duplication (`2>&1` / `1>&2`): no file target to read,
  // just set the merge flag. Same-fd forms (`1>&1` / `2>&2`) silently
  // no-op — they're legal in bash and just redundant.
  if (op.toFd) {
    if (op.fd === '2' && op.toFd === '1') stage.mergeStderrToStdout = true
    else if (op.fd === '1' && op.toFd === '2') stage.mergeStdoutToStderr = true
    return i
  }
  const target = raw[i + 1]
  const label = tokenLabel(op)
  if (op.append) {
    throw new UnsupportedError('feature', label, `filesystem is read-only — \`${label}\` append is not supported; use \`|\` to pipe or \`${prefix}>/dev/null\` to discard`)
  }
  if (!target || target.kind !== 'word') {
    throw new Error(`redirect \`${label}\` requires a target`)
  }
  if (target.value !== '/dev/null') {
    throw new UnsupportedError('feature', label, `filesystem is read-only — use \`|\` to pipe between commands, or \`${label}/dev/null\` to discard`)
  }
  if (op.fd === '1') stage.stdoutToNull = true
  else stage.stderrToNull = true
  return i + 1
}

// Split a stage's tokens into { flags, values, positional } against
// a strict schema. Each command declares the option names it
// understands; any other `-x` / `--xyz` token throws — silent
// acceptance would let typos like `head -X 5` look like they did
// nothing. `--` ends flag processing; subsequent tokens are
// positional. A bare `-` or a token like `-5` (digits) is also
// positional so callers can pass numbers prefixed with `-`.
//
// Schema fields (each accepts an iterable of names; defaults empty):
//   short      — boolean short flags (e.g. `i` for `-i`)
//   long       — boolean long flags (e.g. `verbose` for `--verbose`)
//   valueShort — short flags that consume the next token as value
//                (e.g. `n` for `head -n 5`); inline `-n5` also works
//   valueLong  — long flags that consume the next token as value
//                (e.g. `name` for `find --name foo`). The GNU
//                `--name=value` form is also accepted (the inline
//                value wins and the next token is left untouched).
//   repeatable — value flags (short or long) that may appear more than
//                once; their values collect into an ARRAY in `values`
//                (e.g. `e` for `grep -e a -e b` → `['a', 'b']`) instead
//                of the last-wins scalar a plain value flag stores.
//   stopAtFirstPositional — when true, stop parsing flags as soon
//                as a non-flag positional appears; the rest of the
//                tokens are pushed as positional verbatim. Used by
//                xargs so flags meant for the inner command (e.g.
//                `xargs grep -n PATTERN`) aren't eaten by xargs.
//
// Bundled short flags split across chars (`-an` → `-a` + `-n`); a
// value-taking short inside a bundle takes the rest of the bundle
// as its value (`-n5`).
//
// The result also carries `order`: every value-option — short or long
// — in the sequence it appeared, as `[{ name, value }]`. grep uses it
// to resolve `--include` / `--exclude` by GNU's last-match-wins rule
// and head to resolve `-n` / `-c` the same way; neither is expressible
// through the per-name `values` map, which loses order across names.

export function parseArgs(tokens, schema = {}) {
  const short = asSet(schema.short)
  const long = asSet(schema.long)
  const valueShort = asSet(schema.valueShort)
  const valueLong = asSet(schema.valueLong)
  const repeatable = asSet(schema.repeatable)
  const stopEarly = schema.stopAtFirstPositional ?? false
  const flags = new Set()
  const values = new Map()
  const positional = []
  const order = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    // `--` ends flag processing here, not at the top of the function:
    // a value-taking option (`--name`, `-n`) that immediately precedes
    // `--` consumes it as the value via `takeNext`, so the terminator
    // check has to run AFTER any value-consumption opportunity. POSIX
    // getopt behavior — pre-splitting the token list breaks it.
    if (t === '--') { positional.push(...tokens.slice(i + 1)); break }
    // Pure-dash tokens (`-`, `---`, `----`, …) are positional, not
    // flags. Without this `echo "---"` would die with
    // `unknown option: --` because the `--` long-flag branch (or
    // the short-flag bundle below) would try to interpret it.
    if (/^-+$/u.test(t)) { positional.push(t); continue }
    // A token carrying whitespace can only have come from a quoted
    // string — the tokenizer splits unquoted input on whitespace — so
    // it is data, never an option: `echo "---- foo ----"`, `echo "-n x"`,
    // `grep "-- foo"`. Real getopt rejects these only because the shell
    // strips the quotes before exec; here the quoting survives as the
    // embedded space, so (like the pure-dash sibling above) treat the
    // token as positional. A rare inline value with embedded whitespace
    // (`head -n"3 "`) lands here too rather than as `-n`'s value — an
    // exotic form that errored either way, so the simpler rule wins.
    if (/\s/u.test(t)) { positional.push(t); continue }
    if (t.startsWith('--') && t.length > 2) {
      // GNU long options accept both `--name value` and `--name=value`.
      // Split on the first `=`: everything after it is the inline value,
      // so the next token is left alone. `??` (not `||`) picks the next
      // token only when there is no `=` at all, so `--name=` passes an
      // empty string rather than swallowing the following token. A
      // boolean long handed an inline value (`--verbose=x`) is a user
      // error, surfaced as such instead of silently ignored.
      const eq = t.indexOf('=')
      const name = eq === -1 ? t.slice(2) : t.slice(2, eq)
      const inlineVal = eq === -1 ? null : t.slice(eq + 1)
      if (valueLong.has(name) || repeatable.has(name)) {
        const value = inlineVal ?? takeNext(tokens, ++i, `--${name}`)
        addValue(values, repeatable, name, value)
        order.push({ name, value })
      } else if (long.has(name)) {
        if (inlineVal !== null) throw new Error(`option --${name} doesn't allow an argument`)
        flags.add(name)
      } else throw new UnsupportedError('option', `--${name}`, `unknown option: --${name}`)
      continue
    }
    if (t.startsWith('-') && t.length > 1 && !isNumericPositional(t, short, valueShort, repeatable)) {
      i = consumeShorts(tokens, i, short, valueShort, repeatable, flags, values, order)
      continue
    }
    if (stopEarly) { positional.push(...tokens.slice(i)); break }
    positional.push(t)
  }
  return { flags, values, positional, order }
}

// A `-<digit>` token is positional by default, which is what keeps the
// `head -5` / `ls -10` shorthands working. But a command that DECLARES
// a digit as one of its options means it as an option: `xargs -0` is
// the NUL-separated mode, not a command named `-0`. Consulting the
// schema keeps both readings available without a per-command hack.
function isNumericPositional(token, short, valueShort, repeatable) {
  if (!/^-\d/u.test(token)) return false
  const c = token[1]
  return !short.has(c) && !valueShort.has(c) && !repeatable.has(c)
}

function asSet(v) {
  if (v instanceof Set) return v
  return new Set(v ?? [])
}

function takeNext(tokens, i, label) {
  if (i >= tokens.length) throw new Error(`${label} requires an argument`)
  return tokens[i]
}

// Store a value flag's argument. Repeatable flags accumulate into an
// array (`-e a -e b` → `['a', 'b']`); the rest keep the last value.
function addValue(values, repeatable, name, val) {
  if (!repeatable.has(name)) { values.set(name, val); return }
  const prev = values.get(name)
  if (prev) prev.push(val)
  else values.set(name, [val])
}

function consumeShorts(tokens, i, short, valueShort, repeatable, flags, values, order) {
  const chars = tokens[i].slice(1)
  for (let j = 0; j < chars.length; j++) {
    const c = chars[j]
    if (valueShort.has(c) || repeatable.has(c)) {
      // Inline value (`-n5`) wins over the next token; `++i` only runs
      // in the else branch, so a bundle that carried its own value
      // leaves the token index where it was.
      const value = j + 1 < chars.length ? chars.slice(j + 1) : takeNext(tokens, ++i, `-${c}`)
      addValue(values, repeatable, c, value)
      order.push({ name: c, value })
      return i
    }
    if (!short.has(c)) throw new UnsupportedError('option', `-${c}`, `unknown option: -${c}`)
    flags.add(c)
  }
  return i
}

