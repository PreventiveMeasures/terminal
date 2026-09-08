// awk — the POSIX text-processing language, interpreted in-memory over
// the virtual filesystem. The dialect is POSIX awk plus the gawk
// extensions people actually type (`**`, gensub, length(array),
// delete array, nextfile, switch, BEGINFILE/ENDFILE, IGNORECASE, RT,
// FIELDWIDTHS/FPAT, the bit functions, regex RS, three-argument match).
// Where gawk and other awks differ, gawk is the reference. Everything
// is a real interpreter over an AST — no JS evaluation, and no way for
// a program to reach the host: the forms that would spawn a process or
// write a file (`system()`, `cmd | getline`, `print | cmd`, `print >
// file`) are rejected at parse time with a message saying so.
//
//   awk [-F fs] [-v var=value] 'program' [file ...]
//   awk [-F fs] [-v var=value] -f progfile [file ...]
//
// Operands may also be `var=value` assignments, applied when reached,
// and `-` for stdin. Exit status is the program's `exit` code, 1 for a
// program that does not parse, 2 for a fatal runtime error. gawk's
// warnings (a dubious escape sequence, log of a negative number, ...)
// go to stderr without affecting the status.
//
// The known, deliberate differences from gawk:
//   - Strings are Unicode text, as under a UTF-8 locale: length(),
//     substr(), index() and toupper() count and case-map characters,
//     never bytes, including characters outside the BMP.
//   - NaN formatting is diagnosed because JS does not retain its sign.
//     Locale-sensitive classes on non-ASCII input are also diagnosed.
//   - `for (k in a)` walks keys in insertion order; gawk's order is its
//     hash order. Neither is specified.
//   - ENVIRON and PROCINFO metadata other than "FS" are diagnosed.
//     ARGV[0] is `awk`, and rand() uses a different
//     generator (deterministic, seeded by srand() like gawk's).
//   - Two gawk oddities are not copied: split() with a regex that only
//     matches the empty string at position 0 drops the first character
//     in gawk; an RS regex that can match the empty string yields empty
//     records there.
//   - `sub(/x/, "y", "literal")` is refused (gawk quietly replaces into
//     a temporary), and `a[1][2]` (arrays of arrays) is refused.

import { AwkError } from './awk-common.js'
import { markUnsupported, unsupported, unsupportedFrom, unsupportedNote } from './unsupported.js'
import { unescapeAwkString } from './awk-lex.js'
import { parseProgram } from './awk-parse.js'
import { createMachine, runProgram } from './awk-run.js'
import { StrNum, byteLocale, checkText } from './awk-value.js'
import { lookup } from './fs.js'
import { parseArgs } from './parse.js'
import { err, usage } from './util.js'

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
    // A construct gawk implements and this interpreter refuses is a gap,
    // not a broken program, so it also goes on the run's diagnostic
    // channel. That matters more for awk than for most commands here:
    // the program is a quoted argument, so a caller cannot tell from the
    // exit code alone whether it wrote bad awk or reached for a feature
    // this terminal does not have — and `2>/dev/null` hides the
    // difference completely.
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
    // RangeError covers the engine's own limits (stack depth from a
    // pathologically nested expression, or a string grown past its
    // maximum) — reported like any other fatal error rather than as a
    // crash of the terminal.
    const note = unsupportedNote(e)
    if (!(e instanceof AwkError) && !(e instanceof RangeError) && !note) throw e
    m.errOut.push(`awk: ${e.message}\n`)
    exitCode = 2
    // Same rule as the parse-time catch, for the gaps that can only be
    // reached once the program runs. The result is built by hand here
    // (output already produced still has to survive), so the note is
    // attached to it rather than coming from `unsupported`.
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
    const { path: abs, error } = lookup(ctx.cwd, f, ctx.fs)
    if (error || !ctx.fs.isFile(abs)) return { error: err(`awk: cannot open program file \`${f}\`: ${error ?? 'Is a directory'}`, 2) }
    parts.push(ctx.fs.readFile(abs))
  }
  return { text: parts.join('\n'), operands: positional }
}
