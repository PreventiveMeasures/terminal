// Split a tokenized command line (see tokenize.js) into a sequence of
// pipeline steps with short-circuit gates (`&&` / `||`) between them.
// Each step is a list of stages connected by `|`; each stage carries
// its words (still unexpanded — index.js expands them when the stage
// runs), its assignments, its redirects in the order written, OR (for
// a subshell / brace group) a nested `group` of inner steps, OR (for a
// `for` loop) a `loop` — its variable name, word list and body.
//
// Recognized boundary tokens (the tokenizer itself lives in
// tokenize.js):
//   `|` / `|&` — pipe to the next stage in the current step; `|&` also
//               sends the stage's stderr down the pipe
//   `;`       — sequential run; next step runs regardless of the
//               previous step's exit code (the unconditional sibling
//               of `&&` / `||`)
//   newline   — an unquoted newline ends the current command exactly
//               like `;` (a pasted multi-line block runs line by
//               line). Blank lines and leading/trailing breaks are
//               no-ops; a newline right after `|` / `&&` / `||` / `(`
//               is absorbed so the command continues on the next line.
//   `&&`      — run next step only if current step exited 0
//   `||`      — run next step only if current step exited non-zero
//   `!`       — in front of a pipeline, negates its exit status
//   `(` `)`   — subshell grouping. The contents parse as their own
//               step list and run with an isolated cwd and variables
//               (so `cd` inside `()` doesn't leak out). The group
//               occupies one stage slot and can be piped, gated, and
//               redirected like any other stage.
//   `{` `}`   — a brace group: the same, but sharing the outer cwd
//               and variables, as in bash.
//   `for` … `done`
//             — a `for NAME in WORD…; do LIST; done` loop. `for`, `do`
//               and `done` are reserved words in command position only
//               (`echo done` prints `done`). The body parses as its
//               own step list; the word list is expanded when the
//               loop runs.
//   `NAME=value`
//             — an assignment, before the command word. Alone on a
//               stage it sets the variable; in front of a command it
//               would set it for that command only, which no command
//               here can observe, so it is accepted and ignored.
//   redirects — `>` / `>>` / `>|` / `2>` / `&>` to `/dev/null`,
//               `/dev/stdout` or `/dev/stderr` (the virtual FS is
//               read-only, so a real file is refused), `2>&1` / `>&2`
//               / `2>&-` fd duplication and closing, `<` from a file,
//               `<<` here-documents and `<<<` here-strings. Kept in
//               order and applied left to right at run time, so
//               `2>&1 >/dev/null` means what it means in bash.
//
// Boundary tokens are tagged by `kind`, not by string value, so a
// quoted `"|"` / `">"` / `"("` — or `"for"` — stays an ordinary word.

import { NAME_RE, tokenize } from './tokenize.js'
import { UnsupportedError } from './unsupported.js'

export { parseArgs } from './args.js'

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
  // A comment-only line (or one of only separators) runs nothing.
  if (raw.length === 0) return []
  const { steps, consumed } = buildSteps(raw, 0, null)
  if (consumed !== raw.length) throw new Error(`unexpected \`${tokenLabel(raw[consumed])}\``)
  validateSteps(steps)
  return steps
}

// A "group stage" carries no words — its content is the nested
// `steps`; a "loop stage" likewise carries its content in `loop.body`.
// Their words are unreachable, but checking `.group` / `.loop` first
// lets the same validator handle every shape.
function validateSteps(steps) {
  for (const step of steps) {
    if (step.stages.length === 0 && !step.bang) throw new Error('empty pipeline stage')
    for (const s of step.stages) {
      if (s.group) validateSteps(s.group)
      else if (s.loop) validateSteps(s.loop.body)
      else if (!isCommand(s)) throw new Error('empty pipeline stage')
    }
  }
}

// Whether a stage is something bash would run: a command, an
// assignment-only command, or the null command — redirects alone, which
// bash performs and nothing else, so `>/dev/null` is a complete command
// with status 0 and `! </missing` reports the failure, takes status 1
// from it and negates that to 0. A stage with none of the three
// (`echo a | | wc`) is the empty one.
//
// Consulted before `|&` contributes its own `2>&1` as well as by the
// validator: that redirect is the operator's, not the user's, and
// letting it land first would make the empty stage in `|& echo hi` look
// like a null command instead of the syntax error bash reports.
const isCommand = (s) => s.words.length > 0 || s.assigns.length > 0 || s.redirs.length > 0

const newStage = () => ({ words: [], assigns: [], redirs: [] })
const newStep = (gate) => ({ gate, stages: [], negate: false, bang: false })

// A `!` with nothing after it before the separator — bash's empty
// negated pipeline, a complete command with status 1 (`!` alone on a
// line, `{ !⏎}`, `do !; done`). The step keeps no stage at all.
const bareBang = (step, stage) => step.bang && step.stages.length === 0 && commandPosition(stage) && stage.redirs.length === 0

const wordOf = (t) => ({ value: t.value, mask: t.mask })

// Nothing but assignments has been attached to the stage yet, so the
// next word names a command — the one place the reserved words, `!`,
// `(` and `{` are recognized. Redirects don't count: `>/dev/null (echo
// a)` and `2>/dev/null for …` attach a leading redirect to the group
// or loop that follows.
const commandPosition = (stage) => !stage.group && !stage.loop && stage.words.length === 0 && stage.assigns.length === 0

// Reserved words, recognized unquoted and in command position only.
const KEYWORDS = new Set(['for', 'do', 'done', '{', '}', '!'])

// Closers of blocks this shell never opens (or has already closed). A
// stray one is a syntax error, as in bash — not an unknown command.
const CLOSERS = new Set(['then', 'else', 'elif', 'fi', 'esac', 'in'])

// Block openers bash reserves that this shell does not implement.
// Recognized under the same rule as KEYWORDS — unquoted, command
// position — so `echo while` still prints a word. Naming them here
// rather than letting them fall through to the dispatcher earns two
// things: the diagnostic names the CONSTRUCT rather than the word the
// parser choked on, and the classification is right — `if` is not a
// command this terminal is missing, it is shell syntax it lacks.
const UNIMPLEMENTED_BLOCKS = new Map([
  ['while', '`while` loops are not supported; the only loop is `for NAME in WORD...; do LIST; done`'],
  ['until', '`until` loops are not supported; the only loop is `for NAME in WORD...; do LIST; done`'],
  ['if', '`if` conditionals are not supported; gate on exit status with `&&` / `||` instead'],
  ['case', '`case` statements are not supported; gate on exit status with `&&` / `||` instead'],
  ['select', '`select` loops are not supported'],
  ['function', 'shell functions are not supported'],
  ['[[', '`[[ … ]]` conditional expressions are not supported'],
  ['time', '`time` is not supported'],
  ['coproc', '`coproc` is not supported'],
])

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/u

// `NAME=value` with the name and `=` unquoted; null otherwise.
function assignmentOf(t) {
  const m = ASSIGNMENT.exec(t.value)
  if (!m) return null
  const eq = m[0].length
  if (t.mask !== null && /[12]/u.test(t.mask.slice(0, eq))) return null
  return { name: m[1], word: { value: t.value.slice(eq), mask: t.mask === null ? null : t.mask.slice(eq) } }
}

// Recursive: `end` names the token that closes the block being parsed
// — `)` inside a `(...)` group, `}` inside `{ … }`, `done` inside a
// `for` body, `null` at top level. The returned `consumed` index points
// one past the closing token (or one past the last token at top
// level), letting the caller resume from there.
function buildSteps(raw, start, end) {
  const steps = [newStep('first')]
  let stage = newStage()
  let i = start
  while (i < raw.length) {
    const t = raw[i]
    if (t.kind === 'paren_close') {
      if (end !== ')') throw new Error('unexpected `)`')
      return finishBlock(steps, stage, i + 1, 'empty subshell `()`')
    }
    if (t.kind === 'paren_open') {
      i = openParen(raw, i, stage)
      continue
    }
    if (t.kind === 'pipe' || t.kind === 'pipe_err' || t.kind === 'and' || t.kind === 'or' || t.kind === 'semi') {
      // `|&` is `2>&1 |`, applied after the stage's own redirects.
      if (t.kind === 'pipe_err' && isCommand(stage)) stage.redirs.push({ fd: 2, op: 'dup', toFd: 1 })
      if (!(t.kind === 'semi' && bareBang(steps.at(-1), stage))) steps.at(-1).stages.push(stage)
      stage = newStage()
      if (t.kind === 'and') steps.push(newStep('and'))
      else if (t.kind === 'or') steps.push(newStep('or'))
      else if (t.kind === 'semi') steps.push(newStep('seq'))
      i++
      continue
    }
    if (t.kind === 'dsemi') throw new Error('syntax error near unexpected token `;;`')
    if (t.kind === 'redir') { i = applyRedir(stage, raw, i) + 1; continue }
    // After a closing `)` / `}` / `done` the only legal continuations
    // are a boundary token (handled above) or a redirect for the group
    // or loop itself (also above). Stray words like `(echo a) hi` land
    // here.
    if (stage.group) throw new Error(`unexpected token after \`${stage.isolate ? ')' : '}'}\``)
    if (stage.loop) throw new Error('unexpected token after `done`')
    if (!t.quoted && commandPosition(stage)) {
      const r = commandWord(t, raw, i, steps, stage, end)
      if (r !== null) {
        if (r.done) return r.done
        stage = r.stage ?? stage
        i = r.next
        continue
      }
    }
    const assign = stage.words.length === 0 ? assignmentOf(t) : null
    if (assign === null) stage.words.push(wordOf(t))
    else stage.assigns.push(assign)
    i++
  }
  if (end === ')') throw new Error('unmatched `(`')
  if (end === '}') throw new Error('unmatched `{`')
  if (end === 'done') throw new Error('for: missing `done`')
  if (!bareBang(steps.at(-1), stage)) steps.at(-1).stages.push(stage)
  return { steps, consumed: i }
}

// A `(` at `raw[i]`: a subshell, or one of the two shapes bash spells
// with parentheses that this shell does not have — `((…))` arithmetic
// and `name() { … }` function definitions.
function openParen(raw, i, stage) {
  const next = raw[i + 1]
  if (next?.kind === 'paren_open' && next.adjacent && commandPosition(stage)) {
    throw new UnsupportedError('feature', '((', 'arithmetic evaluation (`((…))`) is not supported')
  }
  if (stage.words.length === 1 && stage.assigns.length === 0 && next?.kind === 'paren_close') {
    throw new UnsupportedError('feature', 'function', `shell functions (\`${stage.words[0].value}() { … }\`) are not supported`)
  }
  // A subshell occupies a whole stage slot. Allowing tokens to
  // accumulate before it (`echo a (cmd)`) would create a words + group
  // hybrid with no sensible semantics, so error early.
  if (!commandPosition(stage)) throw new Error('unexpected `(`')
  const inner = buildSteps(raw, i + 1, ')')
  // Mutate (not replace) the in-flight stage so leading redirects
  // attach to the group: `>/dev/null (echo a)` carries a redirect set
  // by the earlier applyRedir, and we want it to silence the group.
  stage.group = inner.steps
  stage.isolate = true
  return inner.consumed
}

// An unquoted word in command position: a reserved word, a refused
// block, or — returning null — an ordinary command name.
function commandWord(t, raw, i, steps, stage, end) {
  const v = t.value
  if (UNIMPLEMENTED_BLOCKS.has(v)) throw new UnsupportedError('feature', v, UNIMPLEMENTED_BLOCKS.get(v))
  if (CLOSERS.has(v)) throw new Error(`syntax error near unexpected token \`${v}\``)
  if (!KEYWORDS.has(v)) return null
  if (v === '!') {
    if (steps.at(-1).stages.length > 0 || stage.redirs.length > 0) throw new Error('syntax error near unexpected token `!`')
    steps.at(-1).negate = !steps.at(-1).negate
    steps.at(-1).bang = true
    return { next: i + 1 }
  }
  if (v === '{') {
    const inner = buildSteps(raw, skipNewlines(raw, i + 1), '}')
    stage.group = inner.steps
    stage.isolate = false
    return { next: inner.consumed }
  }
  if (v === '}') {
    if (end !== '}') throw new Error('syntax error near unexpected token `}`')
    return { done: finishBlock(steps, stage, i + 1, 'empty group `{ }`') }
  }
  if (v === 'done') {
    if (end !== 'done') throw new Error('unexpected `done`')
    return { done: finishBlock(steps, stage, i + 1, 'for: empty loop body') }
  }
  if (v === 'do') throw new Error('unexpected `do`')
  const loop = parseFor(raw, i + 1)
  // Mutated, not replaced, for the same leading-redirect reason as
  // the group above.
  stage.loop = loop.loop
  return { next: loop.consumed }
}

// The `for` header, starting just past the keyword: NAME, `in`, the
// word list up to a `;` (or newline), then `do`, then the body up to
// `done`. Stricter than bash in one place — `for f; do …; done`, which
// iterates the positional parameters, is refused since there are none
// to iterate. Exactly one separator is skipped at each boundary, so
// `;;` is an error here as in bash; after `do`, only newlines.
function parseFor(raw, start) {
  let i = start
  const nameTok = raw[i]
  if (nameTok?.kind === 'paren_open') throw new UnsupportedError('feature', 'for ((', 'arithmetic `for ((…))` loops are not supported; use `for NAME in WORD...`')
  if (nameTok === undefined || nameTok.kind !== 'word') throw new Error('for: expected a variable name')
  const name = nameTok.value
  if (nameTok.quoted || !NAME_RE.test(name)) throw new Error(`for: \`${name}\` is not a valid variable name`)
  i = skipSemi(raw, i + 1)
  if (!isWord(raw[i], 'in')) {
    if (isWord(raw[i], 'do') || raw[i] === undefined) throw new UnsupportedError('feature', 'for NAME; do', `\`for ${name}; do …\` iterates the positional parameters, which this shell does not have; write \`for ${name} in WORD...\``)
    throw new Error(`for: expected \`in\` after \`${name}\``)
  }
  i++
  // The word list rides with the keyword parked in the command slot,
  // so the expander's argv[0] carve-out lines up: index.js drops that
  // slot after expanding.
  const words = [{ value: 'for', mask: null }]
  // `do` is an ordinary word here, as in bash (`for f in a do; do …`
  // iterates over `do` too); it is only remembered so the error can
  // name the likely cause when the real `do` turns out to be missing.
  let sawDo = false
  for (; i < raw.length && raw[i].kind !== 'semi'; i++) {
    const t = raw[i]
    if (t.kind !== 'word') throw new Error(`for: unexpected \`${tokenLabel(t)}\` in word list`)
    if (isWord(t, 'do')) sawDo = true
    words.push(wordOf(t))
  }
  i = skipSemi(raw, i)
  if (!isWord(raw[i], 'do')) {
    if (sawDo) throw new Error('for: expected `;` or newline before `do`')
    if (i >= raw.length) throw new Error('for: missing `do`')
    throw new Error(`for: expected \`do\`, got \`${tokenLabel(raw[i])}\``)
  }
  const body = buildSteps(raw, skipNewlines(raw, i + 1), 'done')
  return { loop: { name, words, body: body.steps }, consumed: body.consumed }
}

// Index past one `;` at `i`, if there is one — or a newline in the source.
function skipSemi(raw, i) {
  return raw[i]?.kind === 'semi' ? i + 1 : i
}

// Index past the newlines at `i`: after `{` and `do`, bash's grammar
// allows any number of them (a `{` on a line of its own) but no `;`,
// so `{ ;echo hi; }` still fails as in bash — as an empty stage.
function skipNewlines(raw, i) {
  while (raw[i]?.kind === 'semi' && raw[i].newline) i++
  return i
}

// The unquoted word `value`, as opposed to a quoted spelling of it.
function isWord(t, value) {
  return t !== undefined && t.kind === 'word' && !t.quoted && t.value === value
}

// The token as the user would have typed it, for error messages. A
// quoted word keeps its quotes, so a `"do"` that failed to be the
// keyword is not reported as `do`.
const LABELS = { semi: ';', dsemi: ';;', pipe: '|', pipe_err: '|&', and: '&&', or: '||', amp: '&', paren_open: '(', paren_close: ')' }
const REDIR_LABELS = { write: '>', append: '>>', read: '<', heredoc: '<<', herestring: '<<<', both: '&>', bothAppend: '&>>', dup: '>&', close: '>&-' }
function tokenLabel(t) {
  if (t.kind === 'word') return t.quoted ? `"${t.value}"` : t.value
  if (t.kind === 'redir') {
    const base = REDIR_LABELS[t.op]
    if (t.op === 'both' || t.op === 'bothAppend') return base
    const fd = t.fd === (t.op === 'read' || t.op === 'heredoc' || t.op === 'herestring' ? 0 : 1) ? '' : String(t.fd)
    if (t.op === 'dup') return `${fd}${t.fd === 0 ? '<&' : '>&'}${t.toFd}`
    if (t.op === 'close') return `${fd}${t.fd === 0 ? '<&-' : '>&-'}`
    return fd + base
  }
  return LABELS[t.kind]
}

// Close out a `(...)` group, a `{ … }` group or a `for` body. Two cases
// need care:
//   - `()` / `do done` — a truly empty block, distinct error from the
//     generic "empty pipeline stage" so the user sees what they did
//     wrong.
//   - `(echo a;)` / `echo a; done` — trailing `;` before the closer,
//     mirroring the top-level trailing-semi tolerance. The semi already
//     pushed an empty new step; drop it here. Only a `;` earns this: a
//     dangling `&&` / `||` before the closer keeps its empty step for
//     the validator to reject, as `cat x &&` is rejected at top level.
// "Empty" excludes redirects: `(>/dev/null)` and `(echo a; >/dev/null)`
// must NOT drop the redirect — they fall through as an ordinary stage,
// the null command that performs it.
function finishBlock(steps, stage, consumed, emptyError) {
  const lastStep = steps.at(-1)
  const emptyTail = commandPosition(stage) && stage.redirs.length === 0 && lastStep.stages.length === 0
  if (emptyTail && steps.length === 1) throw new Error(emptyError)
  // `{ echo a; ! }`: bash wants a separator after a bare `!`.
  if (emptyTail && lastStep.bang) throw new Error('syntax error near unexpected token after `!`')
  if (emptyTail && lastStep.gate === 'seq') steps.pop()
  else lastStep.stages.push(stage)
  return { steps, consumed }
}

// The write targets that are not files: the virtual FS is read-only,
// so these are the only places a `>` may point.
const DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])

// Record one redirect on the stage, in order. Anything that names a
// file descriptor beyond 0–2, writes to fd 0, or writes to a real path
// is refused here; a target that still needs expansion (`> $out`) is
// kept and checked when the stage runs.
function applyRedir(stage, raw, i) {
  const op = raw[i]
  const label = tokenLabel(op)
  // Duplicating an fd nothing opened is bash's own error (`>&3`: "Bad
  // file descriptor"); opening one (`3>/dev/null`) is legal there and a
  // gap here.
  if (op.op === 'dup' && op.toFd > 2) throw new Error(`${label}: Bad file descriptor`)
  if (op.fd > 2) {
    throw new UnsupportedError('feature', label, `only file descriptors 0, 1 and 2 are supported (got \`${label}\`)`)
  }
  if (op.op === 'dup') {
    if (op.fd === 0 && op.toFd === 0) return i
    if (op.fd === 0 || op.toFd === 0) throw new UnsupportedError('feature', label, `duplicating file descriptor 0 (\`${label}\`) is not supported`)
    stage.redirs.push({ fd: op.fd, op: 'dup', toFd: op.toFd })
    return i
  }
  if (op.op === 'close') {
    stage.redirs.push(op.fd === 0 ? { fd: 0, op: 'text', body: '', expand: false } : { fd: op.fd, op: 'close' })
    return i
  }
  const target = raw[i + 1]
  if (!target || target.kind !== 'word') throw new Error(`redirect \`${label}\` requires a target`)
  if (op.op === 'heredoc' || op.op === 'herestring' || op.op === 'read') {
    // Bash opens `2<<END` or `2<f` on that descriptor, for reading; a
    // command's write into it then fails. Only fd 0 is modeled.
    if (op.fd !== 0) throw new UnsupportedError('feature', label, `reading into file descriptor ${op.fd} (\`${label}\`) is not supported`)
    if (op.op === 'heredoc') stage.redirs.push({ fd: 0, op: 'text', body: op.body ?? '', expand: !op.quotedDelim })
    else if (op.op === 'herestring') stage.redirs.push({ fd: 0, op: 'herestring', word: wordOf(target) })
    else stage.redirs.push({ fd: 0, op: 'read', word: wordOf(target) })
    return i + 1
  }
  if (op.fd === 0) throw new UnsupportedError('feature', label, `writing to file descriptor 0 (\`${label}\`) is not supported`)
  const both = op.op === 'both' || op.op === 'bothAppend'
  const word = wordOf(target)
  if (needsExpansion(word)) {
    stage.redirs.push({ fd: op.fd, op: 'to', word, both, label })
    return i + 1
  }
  if (!DEVICES.has(word.value)) throw refusedWrite(label, word.value)
  stage.redirs.push({ fd: op.fd, op: 'to', target: word.value, both })
  return i + 1
}

// A target that is not yet its final text: a `$` that is not hard-quoted
// (a reference), or a bare `~`, glob character or brace — expanded when
// the stage runs, and checked then (`>/dev/nu*` may well be `/dev/null`).
function needsExpansion(word) {
  return [...word.value].some((ch, i) => {
    const m = word.mask === null ? '0' : word.mask[i]
    return (ch === '$' && m !== '1') || (m === '0' && /[~*?[{]/u.test(ch))
  })
}

// The read-only FS's one refusal, worded for the operator that hit it.
export function refusedWrite(label, target) {
  const discard = label.replace('>>', '>') + '/dev/null'
  return new UnsupportedError('feature', label, `filesystem is read-only — \`${label}\` cannot write to \`${target}\`; use \`|\` to pipe between commands, or \`${discard}\` to discard`)
}
