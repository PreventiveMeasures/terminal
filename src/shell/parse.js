// Parse gated pipelines whose stages contain unexpanded words/assignments,
// ordered redirects, or nested groups, loops and conditionals. Expansion happens
// only when execution reaches a stage. Parentheses isolate cwd/bindings; brace
// groups share them. Redirects retain source order (2>&1 >/dev/null).
// Token kinds and quoting distinguish operators/keywords from literal words.

import { assignmentOf, sliceWord } from './word.js'
import { NAME_RE } from './tokenize.js'
import { UnsupportedError } from '../unsupported.js'
import { advanceAliases } from './aliases.js'
import { IncompleteInput, incomplete, readLine, readUnits, tokenAt } from './parse-input.js'

export const parseLine = (line, writable = false, hasCommand = () => false, options = {}) => readLine(line, writable, hasCommand, options, parseTokens)
export const parseUnits = (line, writable = false, hasCommand = () => false) => readUnits(line, writable, hasCommand, parseTokens)

function parseTokens(tokens, writable, hasCommand, options) {
  const p = { raw: tokens, i: 0, done: !options.read, read: options.read, unitOnly: options.unit, emptyStage: false, writable, aliases: options.aliases ?? new Set(), aliasUsed: options.aliasUsed ?? false, hasCommand, syntaxOnly: options.syntaxOnly }
  try {
    const steps = tokenAt(p) ? buildSteps(p, null) : []
    if (p.emptyStage) throw new Error('empty pipeline stage')
    options.aliasUsed = p.aliasUsed
    options.done = p.done
    return steps
  } catch (e) {
    // Alias replacements can supply grammar tokens. A later parse failure
    // must not hide the unavailable alias expansion that would supply them.
    if (p.aliasUsed && !(e instanceof UnsupportedError)) {
      const gap = new UnsupportedError('feature', 'alias expansion', 'alias expansion is not supported; input using aliases cannot be parsed')
      throw e instanceof IncompleteInput ? new IncompleteInput(gap) : gap
    }
    throw e
  }
}

// Record empty stages while building, but defer the error until the whole
// line parses so later syntax errors retain precedence. Nested readers share p.
function appendStage(p, step, stage) {
  step.stages.push(stage)
  if (!isBlock(stage) && !isCommand(stage)) p.emptyStage = true
}

// Assignments and redirects alone are valid commands. Check emptiness before
// adding |&'s implicit redirect, which must not legitimize an empty stage.
const isCommand = (s) => s.words.length > 0 || s.assigns.length > 0 || s.redirs.length > 0
const isBlock = (s) => s.group || s.loop || s.conditional || s.test

const newStage = () => ({ words: [], assigns: [], redirs: [] })
const newStep = (gate) => ({ gate, stages: [], negate: false, bang: false })

// A `!` with nothing after it before the separator — bash's empty
// negated pipeline, a complete command with status 1 (`!` alone on a
// line, `{ !⏎}`, `do !; done`). The step keeps no stage at all.
const bareBang = (step, stage) => step.bang && step.stages.length === 0 && commandPosition(stage) && stage.redirs.length === 0

// Reserved words require no words or assignments yet; leading redirects may
// still attach to a following block.
const commandPosition = (stage) => !isBlock(stage) && stage.words.length === 0 && stage.assigns.length === 0

// Reserved words, recognized unquoted and in command position only.
const KEYWORDS = new Set(['for', 'do', 'done', 'if', '{', '}', '!'])

// A closer outside its expected block is a syntax error, not an unknown command.
const CLOSERS = new Set(['then', 'else', 'elif', 'fi', 'esac', 'in'])

// Reserved constructs receive feature diagnostics, not command-not-found.
// They are special only when unquoted and in command position.
const UNIMPLEMENTED_BLOCKS = new Map([
  ['while', '`while` loops are not supported; the only loop is `for NAME in WORD...; do LIST; done`'],
  ['until', '`until` loops are not supported; the only loop is `for NAME in WORD...; do LIST; done`'],
  ['case', '`case` statements are not supported; gate on exit status with `&&` / `||` instead'],
  ['select', '`select` loops are not supported'],
  ['function', 'shell functions are not supported'],
  ['time', '`time` is not supported'],
  ['coproc', '`coproc` is not supported'],
])

const ASSIGNMENT_COMMANDS = new Set(['alias', 'declare', 'typeset', 'local', 'readonly', 'export', 'eval', 'let'])

// Recursive readers share one cursor, positioned after any consumed closer.
function buildSteps(p, end) {
  const { raw } = p
  const steps = [newStep('first')]
  if (end === null) p.unit = steps[0]
  let unitStart = 0
  let stage = newStage()
  for (let t; (t = tokenAt(p));) {
    if (t.kind === 'condition') {
      if (!commandPosition(stage)) throw new UnsupportedError('feature', '[[ syntax', 'unexpected `[[`')
      stage.test = t.expression
      p.i++
      continue
    }
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
      if (t.kind === 'pipe_err' && (isCommand(stage) || isBlock(stage))) stage.redirs.push({ fd: 2, op: 'dup', toFd: 1 })
      if (!(t.kind === 'semi' && bareBang(steps.at(-1), stage))) appendStage(p, steps.at(-1), stage)
      stage = newStage()
      if (t.kind === 'and' || t.kind === 'or') steps.push(newStep(t.kind))
      else if (t.kind === 'semi') steps.push(newStep('seq'))
      if (end === null && (t.newline || t.lineEnd)) {
        if (p.unitOnly) { p.i++; steps.pop(); return steps }
        p.aliases = advanceAliases(steps.slice(unitStart, -1), p.aliases, p.hasCommand)
        unitStart = steps.length - 1
        p.unit = steps.at(-1)
      }
      p.i++
      continue
    }
    if (t.kind === 'dsemi') throw new Error('syntax error near unexpected token `;;`')
    if (t.kind === 'redir') {
      // Bash reads a complete top-level line before executing its commands.
      // Warnings precede that unit even when its gated command is skipped.
      if (t.warning) p.unit.warnings = (p.unit.warnings ?? '') + t.warning
      const redir = parseRedirect(p)
      if (redir) stage.redirs.push(redir)
      continue
    }
    // A completed block accepts only a boundary or a redirect.
    if (stage.group) throw new Error(`unexpected token after \`${stage.isolate ? ')' : '}'}\``)
    if (stage.loop) throw new Error('unexpected token after `done`')
    if (stage.conditional) throw new Error('unexpected token after `fi`')
    if (stage.test) throw new UnsupportedError('feature', '[[ syntax', 'unexpected token after `]]`')
    if (!t.quoted && stage.words.length === 0 && p.aliases.has(t.value)) p.aliasUsed = true
    if (!t.quoted && commandPosition(stage)) {
      if (Array.isArray(end) ? end.includes(t.value) : t.value === end) { p.i++; return finishBlock(p, steps, stage, end) }
      if (commandWord(t, p, steps.at(-1), stage)) continue
    }
    const assign = stage.words.length === 0 ? assignmentOf(t) : null
    if (assign === null) stage.words.push(sliceWord(t))
    else stage.assigns.push({ name: assign.name, word: sliceWord(t, assign.end) })
    p.i++
  }
  if (end === ')') throw incomplete('unmatched `(`')
  if (end === '}') throw incomplete('unmatched `{`')
  if (end === 'done') throw incomplete('for: missing `done`')
  if (end) throw incomplete(`if: missing \`${end === 'then' ? 'then' : 'fi'}\``)
  if (!p.emptyStage && !isBlock(stage) && !isCommand(stage) && ['and', 'or', 'pipe', 'pipe_err'].includes(raw.at(-1)?.kind)) throw incomplete('empty pipeline stage')
  if (raw.at(-1)?.kind === 'semi') steps.pop()
  else if (!bareBang(steps.at(-1), stage)) appendStage(p, steps.at(-1), stage)
  return steps
}

// Parentheses open subshells or identify unsupported arrays, arithmetic and
// function definitions. These need feature diagnostics rather than syntax errors.
function openParen(p, stage) {
  const { raw, i } = p
  const next = tokenAt(p, i + 1)
  const previous = raw[i - 1]
  const first = stage.words[0]
  const word = stage.words.at(-1)
  const target = raw[i - 2]?.kind === 'redir' && !['dup', 'close'].includes(raw[i - 2].op)
  const assignment = !target && ((stage.words.length === 0 && stage.assigns.length > 0) ||
    (word && word.value === previous?.value && (stage.words.length === 1 || (first.mask === null && ASSIGNMENT_COMMANDS.has(first.value)))))
  if (assignment && raw[i].wordAdjacent && previous?.kind === 'word' && !previous.quoted && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/u.test(previous.value)) throw new UnsupportedError('feature', 'array assignment', 'shell array assignments are not supported')
  if (next?.kind === 'paren_open' && next.adjacent && commandPosition(stage)) {
    throw new UnsupportedError('feature', '((', 'arithmetic evaluation (`((…))`) is not supported')
  }
  if (stage.words.length === 1 && stage.assigns.length === 0 && stage.redirs.length === 0 && next?.kind === 'paren_close') {
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
  if (v === 'if') stage.conditional = parseConditional(p)
  else stage.loop = parseFor(p)
  return true
}

const BRANCH_ENDS = ['elif', 'else', 'fi']

function parseConditional(p) {
  const branches = []
  let closer
  do {
    skipNewlines(p)
    const condition = buildSteps(p, 'then')
    skipNewlines(p)
    const body = buildSteps(p, BRANCH_ENDS)
    branches.push({ condition, body })
    closer = p.raw[p.i - 1].value
  } while (closer === 'elif')
  let otherwise = null
  if (closer === 'else') {
    skipNewlines(p)
    otherwise = buildSteps(p, 'fi')
  }
  return { branches, otherwise }
}

// Parse NAME in WORDS; do BODY; done. Headers skip exactly one separator;
// bodies allow newlines after do, but not semicolons. Implicit positional-
// parameter loops remain explicitly unsupported.
function parseFor(p) {
  const { raw } = p
  const nameTok = tokenAt(p)
  if (nameTok?.kind === 'paren_open') throw new UnsupportedError('feature', 'for ((', 'arithmetic `for ((…))` loops are not supported; use `for NAME in WORD...`')
  if (nameTok === undefined || nameTok.kind !== 'word') throw new Error('for: expected a variable name')
  const name = nameTok.value
  if (nameTok.quoted || !NAME_RE.test(name)) throw new Error(`for: \`${name}\` is not a valid variable name`)
  p.i++
  const separator = tokenAt(p)
  if (separator?.kind === 'semi') p.i++
  const inToken = tokenAt(p)
  if (separator?.kind === 'semi' && !separator.newline && isWord(inToken, 'in')) throw new Error('for: unexpected `in` after `;`')
  if (!isWord(inToken, 'in')) {
    if (isWord(inToken, 'do') || inToken === undefined) {
      const gap = new UnsupportedError('feature', 'for NAME; do', `\`for ${name}; do …\` iterates the positional parameters, which this shell does not have; write \`for ${name} in WORD...\``)
      throw inToken === undefined ? new IncompleteInput(gap) : gap
    }
    throw new Error(`for: expected \`in\` after \`${name}\``)
  }
  p.i++
  // Execution expands the list as argv, then removes the leading keyword.
  const words = [{ value: 'for', mask: null }]
  // 'do' is a legal list item; remember it only for a missing-separator error.
  let sawDo = false
  for (let t; (t = tokenAt(p)) && t.kind !== 'semi'; p.i++) {
    if (t.kind !== 'word') throw new Error(`for: unexpected \`${tokenLabel(t)}\` in word list`)
    if (isWord(t, 'do')) sawDo = true
    words.push(sliceWord(t))
  }
  if (raw[p.i]?.kind === 'semi') p.i++
  const doToken = tokenAt(p)
  if (!isWord(doToken, 'do')) {
    if (doToken === undefined) throw incomplete(sawDo ? 'for: expected `;` or newline before `do`' : 'for: missing `do`')
    if (sawDo) throw new Error('for: expected `;` or newline before `do`')
    throw new Error(`for: expected \`do\`, got \`${tokenLabel(doToken)}\``)
  }
  p.i++
  skipNewlines(p)
  return { name, words, body: buildSteps(p, 'done') }
}

// Block-opening keywords allow newlines before their lists, but not semicolons.
function skipNewlines(p) {
  for (let t; (t = tokenAt(p))?.kind === 'semi' && t.newline;) p.i++
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
  if (emptyTail && steps.length === 1) throw new Error(end === 'then' ? 'if: empty condition' : EMPTY_BLOCK_ERRORS[end] ?? 'if: empty branch body')
  // `{ echo a; ! }`: bash wants a separator after a bare `!`.
  if (emptyTail && lastStep.bang) throw new Error('syntax error near unexpected token after `!`')
  if (emptyTail && lastStep.gate === 'seq') steps.pop()
  else appendStage(p, lastStep, stage)
  return steps
}

// These devices remain writable even when file writes are disabled.
const DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])

// Consume one redirect and return its execution form. Literal unsupported
// targets fail during parsing; expanded targets are checked at execution.
function parseRedirect(p) {
  const op = p.raw[p.i++]
  const label = tokenLabel(op)
  if (p.syntaxOnly) {
    if (!['dup', 'close'].includes(op.op)) {
      const target = tokenAt(p, p.i++)
      if (!target || target.kind !== 'word') throw new Error(`redirect \`${label}\` requires a target`)
    }
    return op
  }
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
  const target = tokenAt(p, p.i++)
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
  const append = op.op === 'append' || op.op === 'bothAppend'
  const word = sliceWord(target)
  if (needsExpansion(word)) return { fd: op.fd, op: 'to', word, both, append, label }
  if (!p.writable && !DEVICES.has(word.value)) throw refusedWrite(label, word.value, p.writable)
  return { fd: op.fd, op: 'to', target: word.value, both, append, label }
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

export function refusedWrite(label, target, writable) {
  const why = writable ? 'only `/tmp/` is writable' : 'the filesystem is read-only'
  return new UnsupportedError('feature', label, `\`${label}\` cannot write to \`${target}\`: ${why}`)
}
