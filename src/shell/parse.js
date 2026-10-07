// Parse gated pipelines whose stages contain unexpanded words/assignments,
// ordered redirects, or nested groups, loops and conditionals. Expansion happens
// only when execution reaches a stage. Parentheses isolate cwd/bindings; brace
// groups share them. Redirects retain source order (2>&1 >/dev/null).
// Token kinds and quoting distinguish operators/keywords from literal words.

import { assignmentOf, sliceWord } from './word.js'
import { syntaxLabel, tokenLabel } from './lex.js'
import { parseConditional, parseFor, parseFunction, parseWhile, skipNewlines } from './parse-blocks.js'
import { UnsupportedError } from '../unsupported.js'
import { advanceAliases } from './aliases.js'
import { IncompleteInput, readAll, readLine, readUnits, tokenAt, unexpectedEnd, unexpectedToken } from './parse-input.js'

export const parseLine = (line, writable = false, hasCommand = () => false, options = {}) => readLine(line, writable, hasCommand, options, parseTokens)
export const parseUnits = (line, writable = false, hasCommand = () => false) => readUnits(line, writable, hasCommand, parseTokens)
// Parse alone, for a caller describing a line instead of running it.
export const parseAll = (line, writable = false, hasCommand = () => false) => readAll(line, writable, hasCommand, parseTokens)

function parseTokens(tokens, writable, hasCommand, options) {
  const p = { raw: tokens, i: 0, done: !options.read, read: options.read, unitOnly: options.unit, writable, aliases: options.aliases ?? new Set(), aliasUsed: options.aliasUsed ?? false, hasCommand, syntaxOnly: options.syntaxOnly, closer: options.closer, lexError: options.lexError }
  try {
    const steps = tokenAt(p) ? buildSteps(p, null) : []
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

// A stage with nothing in it is where bash's grammar stops, at the token that
// ended it: `;` in `a; ; b`, `|` in `| b`, the `done` of `do a && done`.
function appendStage(step, stage, token) {
  if (!isBlock(stage) && !isCommand(stage)) throw unexpectedToken(syntaxLabel(token))
  step.stages.push(stage)
}

// Assignments and redirects alone are valid commands. Check emptiness before
// adding |&'s implicit redirect, which must not legitimize an empty stage.
const isCommand = (s) => s.words.length > 0 || s.assigns.length > 0 || s.redirs.length > 0
const isBlock = (s) => s.group || s.loop || s.conditional || s.test || s.define

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
const KEYWORDS = new Set(['for', 'while', 'until', 'do', 'done', 'if', '{', '}', '!'])

// A closer outside its expected block is a syntax error, not an unknown command.
const CLOSERS = new Set(['then', 'else', 'elif', 'fi', 'esac', 'in'])

// Reserved constructs receive feature diagnostics, not command-not-found.
// They are special only when unquoted and in command position.
const UNIMPLEMENTED_BLOCKS = new Map([
  ['case', '`case` statements are not supported; gate on exit status with `&&` / `||` instead'],
  ['select', '`select` loops are not supported'],
  ['function', 'shell functions are not supported'],
  ['time', '`time` is not supported'],
  ['coproc', '`coproc` is not supported'],
])

const ASSIGNMENT_COMMANDS = new Set(['alias', 'declare', 'typeset', 'local', 'readonly', 'export', 'eval', 'let'])

// What stands between two commands, and which of those end the one before
// rather than join it to the next: `;` and `&` both close a list, so either
// may be the last thing a line says.
const SEPARATORS = new Set(['pipe', 'pipe_err', 'and', 'or', 'semi', 'amp'])
const ENDS_LIST = new Set(['semi', 'amp'])

// Recursive readers share one cursor, positioned after any consumed closer.
function buildSteps(p, end) {
  const { raw } = p
  const steps = [newStep('first')]
  if (end === null) p.unit = steps[0]
  let unitStart = 0
  let stage = newStage()
  for (let t; (t = tokenAt(p));) {
    if (t.kind === 'condition') {
      if (!commandPosition(stage)) throw unexpectedToken('[[')
      stage.test = t.expression
      p.i++
      continue
    }
    if (t.kind === 'paren_close') {
      if (end !== ')') throw unexpectedToken(')')
      p.i++
      return finishBlock(p, steps, stage)
    }
    if (t.kind === 'paren_open') {
      openParen(p, stage)
      continue
    }
    if (SEPARATORS.has(t.kind)) {
      // `|&` is `2>&1 |`, applied after the stage's own redirects.
      if (t.kind === 'pipe_err' && (isCommand(stage) || isBlock(stage))) stage.redirs.push({ fd: 2, op: 'dup', toFd: 1 })
      if (!(t.kind === 'semi' && bareBang(steps.at(-1), stage))) appendStage(steps.at(-1), stage, t)
      // `&` gives the whole `a && b` list it closes to the background, and
      // bash takes it as the separator it also is: `a & b` runs both.
      if (t.kind === 'amp') steps.at(-1).background = true
      stage = newStage()
      if (t.kind === 'and' || t.kind === 'or') steps.push(newStep(t.kind))
      else if (ENDS_LIST.has(t.kind)) steps.push(newStep('seq'))
      if (end === null && (t.newline || t.lineEnd)) {
        if (p.unitOnly) { p.i++; steps.pop(); return steps }
        p.aliases = advanceAliases(steps.slice(unitStart, -1), p.aliases, p.hasCommand)
        unitStart = steps.length - 1
        p.unit = steps.at(-1)
      }
      p.i++
      continue
    }
    if (t.kind === 'dsemi') throw unexpectedToken(';;')
    if (t.kind === 'redir') {
      // Bash reads a complete top-level line before executing its commands.
      // Warnings precede that unit even when its gated command is skipped.
      if (t.warning) p.unit.warnings = (p.unit.warnings ?? '') + t.warning
      if (stage.define) throw new UnsupportedError('feature', 'function', `\`${stage.define.name}()\` with a redirect of its own is not supported`)
      const redir = parseRedirect(p)
      if (redir) stage.redirs.push(redir)
      continue
    }
    // A completed block accepts only a boundary, a redirect, or — since bash
    // reads a reserved word after a `}`, `)`, `fi`, `done` or `]]` — the
    // closer of the block around it: `{ { a; } }`. A definition ends on its
    // `}` like a group, and bash rejects a word after either.
    const closes = !t.quoted && (Array.isArray(end) ? end.includes(t.value) : t.value === end)
    if (closes && (commandPosition(stage) || isBlock(stage))) { p.i++; return finishBlock(p, steps, stage) }
    if (isBlock(stage)) throw unexpectedToken(syntaxLabel(t))
    if (!t.quoted && stage.words.length === 0 && p.aliases.has(t.value)) p.aliasUsed = true
    if (!t.quoted && commandPosition(stage) && commandWord(t, p, steps.at(-1), stage)) continue
    const assign = stage.words.length === 0 ? assignmentOf(t) : null
    if (assign === null) stage.words.push(sliceWord(t))
    else stage.assigns.push({ name: assign.name, word: sliceWord(t, assign.end) })
    p.i++
  }
  // A block still open, or a `|`, `&&` or `||` still waiting for its command,
  // is input that ends where the grammar wants more.
  if (end !== null || (!isBlock(stage) && !isCommand(stage) && !ENDS_LIST.has(raw.at(-1)?.kind) && !bareBang(steps.at(-1), stage))) throw unexpectedEnd(p)
  if (ENDS_LIST.has(raw.at(-1)?.kind)) steps.pop()
  else if (!bareBang(steps.at(-1), stage)) appendStage(steps.at(-1), stage)
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
  const definition = stage.words.length === 1 && stage.assigns.length === 0 && stage.redirs.length === 0
  if (definition && next?.kind === 'paren_close') {
    // The name as its token has it, quotes and all: they decide whether
    // bash takes it for a name.
    stage.words.pop()
    stage.define = parseFunction(p, previous, buildSteps)
    return
  }
  // `name (` can only open a definition, which wants its `)` next; anywhere
  // else a subshell occupies a whole stage, but retains any leading redirects.
  if (definition) throw unexpectedToken(syntaxLabel(next))
  if (!commandPosition(stage)) throw unexpectedToken('(')
  p.i++
  stage.group = buildSteps(p, ')')
  stage.isolate = true
}

// An unquoted word in command position: a reserved word, a refused
// block, or — returning false — an ordinary command name.
function commandWord(t, p, step, stage) {
  const v = t.value
  if (UNIMPLEMENTED_BLOCKS.has(v)) throw new UnsupportedError('feature', v, UNIMPLEMENTED_BLOCKS.get(v))
  if (CLOSERS.has(v)) throw unexpectedToken(syntaxLabel(t))
  if (!KEYWORDS.has(v)) return false
  p.i++
  if (v === '!') {
    if (step.stages.length > 0 || stage.redirs.length > 0) throw unexpectedToken('!')
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
  if (v === '}' || v === 'done' || v === 'do') throw unexpectedToken(v)
  if (v === 'if') stage.conditional = parseConditional(p, buildSteps)
  else stage.loop = v === 'for' ? parseFor(p, buildSteps) : parseWhile(p, v, buildSteps)
  return true
}

// A trailing ';' creates an empty tail to discard, while trailing &&/||
// must remain invalid. Redirect-only stages are not empty; a block with
// nothing in it at all, and a bare '!' before a closer, stop bash's grammar
// at the closer.
function finishBlock(p, steps, stage) {
  const lastStep = steps.at(-1)
  const closer = p.raw[p.i - 1]
  const emptyTail = commandPosition(stage) && stage.redirs.length === 0 && lastStep.stages.length === 0
  if (emptyTail && (steps.length === 1 || lastStep.bang)) throw unexpectedToken(syntaxLabel(closer))
  if (emptyTail && lastStep.gate === 'seq') steps.pop()
  else appendStage(lastStep, stage, closer)
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
      if (!target || target.kind !== 'word') throw missingTarget(p, target)
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
  if (!target || target.kind !== 'word') throw missingTarget(p, target)
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

// A redirect wants a word next, and the grammar stops at whatever stands
// there instead — the end of the line, or of a `$( … )`, included.
const missingTarget = (p, target) => unexpectedToken(target === undefined && p.closer ? p.closer : syntaxLabel(target))

// A target that is not yet its final text: a `$` or a backtick that quoting
// has not disarmed — a reference, or commands whose output the name is — a
// `<( … )`, whose name is a path nothing has opened yet, or a bare `~`, glob
// character or brace. All of those are expanded when the stage runs and
// checked then, `>/dev/nu*` may well being `/dev/null`. Masks count UTF-16
// units, so index the value the same way rather than by code point.
function needsExpansion(word) {
  for (let i = 0; i < word.value.length; i++) {
    const ch = word.value[i]
    const m = word.mask === null ? '0' : word.mask[i]
    if ((ch === '$' || ch === '`') && m !== '1') return true
    if (m === '0' && (/[~*?[{]/u.test(ch) || ((ch === '<' || ch === '>') && word.value[i + 1] === '('))) return true
  }
  return false
}

export function refusedWrite(label, target, writable) {
  const why = writable ? 'only `/tmp/` is writable' : 'the filesystem is read-only'
  return new UnsupportedError('feature', label, `\`${label}\` cannot write to \`${target}\`: ${why}`)
}
