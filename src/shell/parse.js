// Parse gated pipelines whose stages contain unexpanded words/assignments,
// ordered redirects, a nested group, or a for-loop. Expansion happens only
// when execution reaches a stage. Parentheses isolate cwd/bindings; brace
// groups share them. Redirects retain source order (2>&1 >/dev/null).
// Token kinds and quoting distinguish operators/keywords from literal words.

import { assignmentOf, sliceWord } from './word.js'
import { NAME_RE, tokenize } from './tokenize.js'
import { UnsupportedError } from '../unsupported.js'

export function parseLine(line) {
  const raw = tokenize(line)
  for (const t of raw) {
    if (t.kind === 'amp') throw new UnsupportedError('feature', '&', 'background processes (`&`) are not supported')
  }
  // Trailing semicolons are harmless; trailing &&/|| remain incomplete.
  while (raw.length > 0 && raw.at(-1).kind === 'semi') raw.pop()
  // A comment-only line (or one of only separators) runs nothing.
  if (raw.length === 0) return []
  const p = { raw, i: 0, emptyStage: false }
  const steps = buildSteps(p, null)
  if (p.emptyStage) throw new Error('empty pipeline stage')
  return steps
}

// Record empty stages while building, but defer the error until the whole
// line parses so later syntax errors retain precedence. Nested readers share p.
function appendStage(p, step, stage) {
  step.stages.push(stage)
  if (!stage.group && !stage.loop && !isCommand(stage)) p.emptyStage = true
}

// Assignments and redirects alone are valid commands. Check emptiness before
// adding |&'s implicit redirect, which must not legitimize an empty stage.
const isCommand = (s) => s.words.length > 0 || s.assigns.length > 0 || s.redirs.length > 0

const newStage = () => ({ words: [], assigns: [], redirs: [] })
const newStep = (gate) => ({ gate, stages: [], negate: false, bang: false })

// A `!` with nothing after it before the separator — bash's empty
// negated pipeline, a complete command with status 1 (`!` alone on a
// line, `{ !⏎}`, `do !; done`). The step keeps no stage at all.
const bareBang = (step, stage) => step.bang && step.stages.length === 0 && commandPosition(stage) && stage.redirs.length === 0

// Reserved words require no words or assignments yet; leading redirects may
// still attach to a following group or loop.
const commandPosition = (stage) => !stage.group && !stage.loop && stage.words.length === 0 && stage.assigns.length === 0

// Reserved words, recognized unquoted and in command position only.
const KEYWORDS = new Set(['for', 'do', 'done', '{', '}', '!'])

// Closers of blocks this shell never opens (or has already closed). A
// stray one is a syntax error, as in bash — not an unknown command.
const CLOSERS = new Set(['then', 'else', 'elif', 'fi', 'esac', 'in'])

// Reserved constructs receive feature diagnostics, not command-not-found.
// They are special only when unquoted and in command position.
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

// Recursive readers share one cursor, positioned after any consumed closer.
function buildSteps(p, end) {
  const { raw } = p
  const steps = [newStep('first')]
  let stage = newStage()
  while (p.i < raw.length) {
    const t = raw[p.i]
    if (t.kind === 'paren_close') {
      if (end !== ')') throw new Error('unexpected `)`')
      p.i++
      return finishBlock(p, steps, stage, end)
    }
    if (t.kind === 'paren_open') {
      openParen(p, stage)
      continue
    }
    if (t.kind === 'pipe' || t.kind === 'pipe_err' || t.kind === 'and' || t.kind === 'or' || t.kind === 'semi') {
      // `|&` is `2>&1 |`, applied after the stage's own redirects.
      if (t.kind === 'pipe_err' && (isCommand(stage) || stage.group || stage.loop)) stage.redirs.push({ fd: 2, op: 'dup', toFd: 1 })
      if (!(t.kind === 'semi' && bareBang(steps.at(-1), stage))) appendStage(p, steps.at(-1), stage)
      stage = newStage()
      if (t.kind === 'and' || t.kind === 'or') steps.push(newStep(t.kind))
      else if (t.kind === 'semi') steps.push(newStep('seq'))
      p.i++
      continue
    }
    if (t.kind === 'dsemi') throw new Error('syntax error near unexpected token `;;`')
    if (t.kind === 'redir') {
      const redir = parseRedirect(p)
      if (redir) stage.redirs.push(redir)
      continue
    }
    // A completed group/loop accepts only a boundary or a redirect.
    if (stage.group) throw new Error(`unexpected token after \`${stage.isolate ? ')' : '}'}\``)
    if (stage.loop) throw new Error('unexpected token after `done`')
    if (!t.quoted && commandPosition(stage)) {
      if (t.value === end) { p.i++; return finishBlock(p, steps, stage, end) }
      if (commandWord(t, p, steps.at(-1), stage)) continue
    }
    const assign = stage.words.length === 0 ? assignmentOf(t) : null
    if (assign === null) stage.words.push(sliceWord(t))
    else stage.assigns.push({ name: assign.name, word: sliceWord(t, assign.end) })
    p.i++
  }
  if (end === ')') throw new Error('unmatched `(`')
  if (end === '}') throw new Error('unmatched `{`')
  if (end === 'done') throw new Error('for: missing `done`')
  if (!bareBang(steps.at(-1), stage)) appendStage(p, steps.at(-1), stage)
  return steps
}

// Parentheses open subshells or identify unsupported arrays, arithmetic and
// function definitions. These need feature diagnostics rather than syntax errors.
function openParen(p, stage) {
  const { raw, i } = p
  const next = raw[i + 1]
  if (stage.words.length <= 1 && raw[i].wordAdjacent && raw[i - 1]?.kind === 'word' && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/u.test(raw[i - 1].value)) throw new UnsupportedError('feature', 'array assignment', 'shell array assignments are not supported')
  if (next?.kind === 'paren_open' && next.adjacent && commandPosition(stage)) {
    throw new UnsupportedError('feature', '((', 'arithmetic evaluation (`((…))`) is not supported')
  }
  if (stage.words.length === 1 && stage.assigns.length === 0 && next?.kind === 'paren_close') {
    throw new UnsupportedError('feature', 'function', `shell functions (\`${stage.words[0].value}() { … }\`) are not supported`)
  }
  // A subshell occupies a whole stage, but retains any leading redirects.
  if (!commandPosition(stage)) throw new Error('unexpected `(`')
  p.i++
  stage.group = buildSteps(p, ')')
  stage.isolate = true
}

// An unquoted word in command position: a reserved word, a refused
// block, or — returning false — an ordinary command name.
function commandWord(t, p, step, stage) {
  const v = t.value
  if (UNIMPLEMENTED_BLOCKS.has(v)) throw new UnsupportedError('feature', v, UNIMPLEMENTED_BLOCKS.get(v))
  if (CLOSERS.has(v)) throw new Error(`syntax error near unexpected token \`${v}\``)
  if (!KEYWORDS.has(v)) return false
  p.i++
  if (v === '!') {
    if (step.stages.length > 0 || stage.redirs.length > 0) throw new Error('syntax error near unexpected token `!`')
    step.negate = !step.negate
    step.bang = true
    return true
  }
  if (v === '{') {
    skipNewlines(p)
    stage.group = buildSteps(p, '}')
    stage.isolate = false
    return true
  }
  if (v === '}') throw new Error('syntax error near unexpected token `}`')
  if (v === 'done') throw new Error('unexpected `done`')
  if (v === 'do') throw new Error('unexpected `do`')
  stage.loop = parseFor(p)
  return true
}

// Parse NAME in WORDS; do BODY; done. Headers skip exactly one separator;
// bodies allow newlines after do, but not semicolons. Implicit positional-
// parameter loops remain explicitly unsupported.
function parseFor(p) {
  const { raw } = p
  const nameTok = raw[p.i]
  if (nameTok?.kind === 'paren_open') throw new UnsupportedError('feature', 'for ((', 'arithmetic `for ((…))` loops are not supported; use `for NAME in WORD...`')
  if (nameTok === undefined || nameTok.kind !== 'word') throw new Error('for: expected a variable name')
  const name = nameTok.value
  if (nameTok.quoted || !NAME_RE.test(name)) throw new Error(`for: \`${name}\` is not a valid variable name`)
  p.i++
  if (raw[p.i]?.kind === 'semi') p.i++
  if (!isWord(raw[p.i], 'in')) {
    if (isWord(raw[p.i], 'do') || raw[p.i] === undefined) throw new UnsupportedError('feature', 'for NAME; do', `\`for ${name}; do …\` iterates the positional parameters, which this shell does not have; write \`for ${name} in WORD...\``)
    throw new Error(`for: expected \`in\` after \`${name}\``)
  }
  p.i++
  // Execution expands the list as argv, then removes the leading keyword.
  const words = [{ value: 'for', mask: null }]
  // 'do' is a legal list item; remember it only for a missing-separator error.
  let sawDo = false
  for (; p.i < raw.length && raw[p.i].kind !== 'semi'; p.i++) {
    const t = raw[p.i]
    if (t.kind !== 'word') throw new Error(`for: unexpected \`${tokenLabel(t)}\` in word list`)
    if (isWord(t, 'do')) sawDo = true
    words.push(sliceWord(t))
  }
  if (raw[p.i]?.kind === 'semi') p.i++
  if (!isWord(raw[p.i], 'do')) {
    if (sawDo) throw new Error('for: expected `;` or newline before `do`')
    if (p.i >= raw.length) throw new Error('for: missing `do`')
    throw new Error(`for: expected \`do\`, got \`${tokenLabel(raw[p.i])}\``)
  }
  p.i++
  skipNewlines(p)
  return { name, words, body: buildSteps(p, 'done') }
}

// Newlines are allowed after '{' and 'do'; semicolons are not.
function skipNewlines(p) {
  while (p.raw[p.i]?.kind === 'semi' && p.raw[p.i].newline) p.i++
}

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

// A trailing ';' creates an empty tail to discard, while trailing &&/||
// must remain invalid. Redirect-only stages are not empty; a truly empty
// block and a bare '!' before a closer have their own syntax errors.
const EMPTY_BLOCK_ERRORS = { ')': 'empty subshell `()`', '}': 'empty group `{ }`', done: 'for: empty loop body' }

function finishBlock(p, steps, stage, end) {
  const lastStep = steps.at(-1)
  const emptyTail = commandPosition(stage) && stage.redirs.length === 0 && lastStep.stages.length === 0
  if (emptyTail && steps.length === 1) throw new Error(EMPTY_BLOCK_ERRORS[end])
  // `{ echo a; ! }`: bash wants a separator after a bare `!`.
  if (emptyTail && lastStep.bang) throw new Error('syntax error near unexpected token after `!`')
  if (emptyTail && lastStep.gate === 'seq') steps.pop()
  else appendStage(p, lastStep, stage)
  return steps
}

// The write targets that are not files: the virtual FS is read-only,
// so these are the only places a `>` may point.
const DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])

// Consume one redirect and return its execution form. Literal unsupported
// targets fail during parsing; expanded targets are checked at execution.
function parseRedirect(p) {
  const op = p.raw[p.i++]
  const label = tokenLabel(op)
  // Duplicating an fd nothing opened is bash's own error (`>&3`: "Bad
  // file descriptor"); opening one (`3>/dev/null`) is legal there and a
  // gap here.
  if (op.op === 'dup' && op.toFd > 2) throw new Error(`${label}: Bad file descriptor`)
  if (op.fd > 2) {
    throw new UnsupportedError('feature', label, `only file descriptors 0, 1 and 2 are supported (got \`${label}\`)`)
  }
  if (op.op === 'dup') {
    if (op.fd === 0 && op.toFd === 0) return null
    if (op.fd === 0 || op.toFd === 0) throw new UnsupportedError('feature', label, `duplicating file descriptor 0 (\`${label}\`) is not supported`)
    return { fd: op.fd, op: 'dup', toFd: op.toFd }
  }
  if (op.op === 'close') {
    if (op.fd === 0) throw new UnsupportedError('feature', '0<&-', 'closing standard input is not supported')
    return { fd: op.fd, op: 'close' }
  }
  const target = p.raw[p.i++]
  if (!target || target.kind !== 'word') throw new Error(`redirect \`${label}\` requires a target`)
  if (op.op === 'heredoc' || op.op === 'herestring' || op.op === 'read') {
    // Bash opens `2<<END` or `2<f` on that descriptor, for reading; a
    // command's write into it then fails. Only fd 0 is modeled.
    if (op.fd !== 0) throw new UnsupportedError('feature', label, `reading into file descriptor ${op.fd} (\`${label}\`) is not supported`)
    if (op.op === 'heredoc') return { fd: 0, op: 'text', body: op.body ?? '', expand: !op.quotedDelim }
    return { fd: 0, op: op.op, word: sliceWord(target) }
  }
  if (op.fd === 0) throw new UnsupportedError('feature', label, `writing to file descriptor 0 (\`${label}\`) is not supported`)
  const both = op.op === 'both' || op.op === 'bothAppend'
  const word = sliceWord(target)
  if (needsExpansion(word)) return { fd: op.fd, op: 'to', word, both, label }
  if (!DEVICES.has(word.value)) throw refusedWrite(label, word.value)
  return { fd: op.fd, op: 'to', target: word.value, both }
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

export function refusedWrite(label, target) {
  const discard = label.replace('>>', '>') + '/dev/null'
  return new UnsupportedError('feature', label, `filesystem is read-only — \`${label}\` cannot write to \`${target}\`; use \`|\` to pipe between commands, or \`${discard}\` to discard`)
}
