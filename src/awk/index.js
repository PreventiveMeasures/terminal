// POSIX awk and supported gawk extensions, interpreted over the virtual FS.
// No program evaluation can execute JavaScript or spawn a host process.
// Output is limited to stdout, stderr and /dev/null; unsupported forms are
// diagnosed at parse time when possible, and at runtime otherwise.
//
// File operands can include assignments (applied when reached) and `-` for
// stdin. Parse errors exit 1, fatal errors exit 2, and warnings keep status.
//
// Deliberate limits include locale-sensitive non-ASCII regexes, signed NaN
// formatting, arrays of arrays, and unavailable environment/process metadata.
// Array iteration uses insertion order; rand() uses a deterministic generator
// different from gawk's. split()/RS ignore empty separators, including gawk's
// exceptional cases, and sub() refuses substitution into a temporary value.

import { AwkError } from './common.js'
import { markUnsupported, unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { unescapeAwkString } from './lex.js'
import { parseProgram } from './parse.js'
import { createMachine, runProgram } from './run.js'
import { StrNum, byteLocale, checkText } from './value.js'
import { lookupWithNote } from '../notes.js'
import { parseArgs } from '../args.js'
import { err, usage } from '../util.js'

const USAGE = "awk [-F fs] [-v var=value] 'program' [file ...]  |  awk [-F fs] [-v var=value] -f progfile [file ...]"
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([^]*)$/u

export function awk(stdin, tokens, ctx) {
  // Option parsing stops at the program text (as gawk's does), so a
  // later `-x` is an operand, not a flag the program cannot see.
  const { values, positional } = parseArgs(splitGluedValues(tokens), { valueShort: ['F'], repeatable: ['v', 'f'], stopAtFirstPositional: true })
  const source = programSource(values.get('f') ?? [], positional, ctx)
  if (source.error) return source.error
  let program
  try {
    checkText({ byteLocale: byteLocale(ctx) }, source.text)
    program = parseProgram(source.text)
  } catch (e) {
    // A RangeError here is the parser's own recursion giving out on a
    // pathologically nested expression: a program we cannot compile.
    if (e instanceof RangeError) return unsupported('feature', 'awk', 'parser depth limit', `awk: program too deeply nested (${e.message})`)
    if (unsupportedNote(e)) return unsupportedFrom(e, 'awk', `awk: ${e.message}`)
    if (!(e instanceof AwkError)) throw e
    const message = e.line === null ? `awk: ${e.message}` : `awk: syntax error at line ${e.line}: ${e.message}`
    // Unsupported constructs also reach diagnostics when stderr is redirected.
    return e.gap === null ? err(message) : unsupported('feature', 'awk', e.gap, message)
  }
  const m = createMachine(program, ctx, stdin, source.operands)
  for (const w of program.warnings) m.warn(w)
  let exitCode
  let gap = null
  try {
    if (values.has('F')) m.assign('FS', unescapeAwkString(values.get('F'), m.warn))
    for (const asg of values.get('v') ?? []) {
      const match = ASSIGNMENT.exec(asg)
      if (!match) return err(`awk: -v: expected var=value but got \`${asg}\``)
      m.assign(match[1], new StrNum(unescapeAwkString(match[2], m.warn)))
    }
    exitCode = runProgram(m)
  } catch (e) {
    // Report engine stack/string limits without crashing the terminal.
    const note = unsupportedNote(e)
    if (!(e instanceof AwkError) && !(e instanceof RangeError) && !note) throw e
    m.errOut.push(`awk: ${e.message}\n`)
    exitCode = 2
    // Preserve output already produced when attaching a runtime diagnostic.
    if (e instanceof RangeError) gap = { detail: 'runtime limit', message: `awk: ${e.message}` }
    if (e.gap) gap = { detail: e.gap, message: `awk: ${e.message}` }
    if (note) gap = { detail: note.detail, message: `awk: ${e.message}` }
  }
  const result = { stdout: m.out.join(''), stderr: m.errOut.join(''), exitCode }
  return gap === null ? result : markUnsupported(result, 'feature', 'awk', gap.detail, gap.message)
}

// `-F', *'` reaches us as the single token `-F, *`: the shell glues a
// quoted value to its flag, and parseArgs treats any token carrying
// whitespace as positional — which here would make it the program.
// Peel the flag off such tokens, up to the first real positional. A
// bare `-F` / `-v` / `-f` keeps its next token as the value untouched.
const GLUED = /^-[Fvf]\S*\s/su

function splitGluedValues(tokens) {
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-F' || t === '-v' || t === '-f') {
      out.push(t)
      if (i + 1 < tokens.length) out.push(tokens[++i])
      continue
    }
    if (GLUED.test(t)) { out.push(t.slice(0, 2), t.slice(2)); continue }
    if (!t.startsWith('-') || t === '-' || t === '--') { out.push(...tokens.slice(i)); break }
    out.push(t)
  }
  return out
}

// The program comes from `-f progfile` (several concatenate) or, failing
// that, the first operand.
function programSource(progFiles, positional, ctx) {
  if (progFiles.length === 0) {
    if (positional.length === 0) return { error: usage(USAGE) }
    return { text: positional[0], operands: positional.slice(1) }
  }
  const parts = []
  for (const f of progFiles) {
    const { path: abs, error } = lookupWithNote(ctx, 'awk', f)
    if (error || !ctx.fs.isFile(abs)) return { error: err(`awk: cannot open program file \`${f}\`: ${error ?? 'Is a directory'}`, 2) }
    parts.push(ctx.fs.readFile(abs))
  }
  return { text: parts.join('\n'), operands: positional }
}
