// POSIX awk and supported gawk extensions, interpreted over the virtual FS.
// No program evaluation can execute JavaScript or spawn a host process.
// Output is limited to stdout, stderr and /dev/null; unsupported forms are
// diagnosed at parse time when possible, and at runtime otherwise.
//
// File operands can include assignments (applied when reached) and `-` for
// stdin. What goes wrong is reported in gawk's words and form — a program
// gawk would not run exits 1, a fatal error at run time 2, and warnings
// keep the status — and where that form cannot be known to be gawk's, the
// report is also an unsupported one.
//
// The program is read with gawk's grammar (./parse.js), so what it accepts
// and what it says of a program it rejects are gawk's. Deliberate limits
// include signed NaN formatting, arrays of arrays, and unavailable
// environment/process metadata; split() and FS take an empty match as no
// separator, as gawk does, and a regex RS that could match empty before
// the end of its input is refused.

import { AwkError, createParseLog } from './common.js'
import { markUnsupported, unsupported, unsupportedFrom, unsupportedNote } from '../unsupported.js'
import { unescapeAwkString } from './lex.js'
import { parseProgram } from './parse.js'
import { createMachine, runProgram, where } from './run.js'
import { StrNum, byteLocale, checkText } from './value.js'
import { lookupWithNote } from '../notes.js'
import { consumeStdin } from '../util.js'
import { err } from '../result.js'
import { USAGE, gawkOptions, illegalName } from './options.js'

export function awk(stdin, tokens, ctx) {
  const opts = gawkOptions(tokens)
  if (opts.result) return opts.result
  const source = programSources(opts, stdin, ctx)
  if (source.result) return source.result
  const { sources, operands } = source
  const vars = []
  for (const item of opts.assigns) {
    if (item.kind !== 'v') continue
    const eq = item.value.indexOf('=')
    if (eq === -1) return err(`awk: \`${item.value}' argument to \`-v' not in \`var=value' form\n\n${USAGE}`, 1)
    const bad = illegalName(item.value.slice(0, eq))
    if (bad) return err(`awk: fatal: ${bad}`, 2)
    vars.push(item.value.slice(0, eq))
  }
  const once = new Set()
  const log = createParseLog(once)
  let program
  try {
    for (const s of sources) checkText({ byteLocale: byteLocale(ctx) }, s.text)
    program = parseProgram(sources, log, vars)
  } catch (e) {
    return parseFailure(e, log, sources)
  }
  if (log.errors > 0) return err(log.render(sources), 1)
  const m = createMachine(program, ctx, source.stdin, operands, once)
  m.errOut.push(log.render(sources))
  return run(m, opts)
}

// The run, with -F and -v applied first in command-line order (their
// warnings name no place in the program, as gawk's do not).
function run(m, opts) {
  let exitCode
  let gap = null
  try {
    for (const { kind, value } of opts.assigns) {
      const warn = (msg, key) => m.warnAt('', msg, key)
      if (kind === 'F') m.assign('FS', unescapeAwkString(value, warn, true))
      else m.assign(value.slice(0, value.indexOf('=')), new StrNum(unescapeAwkString(value.slice(value.indexOf('=') + 1), warn)))
    }
    exitCode = runProgram(m)
  } catch (e) {
    // Report engine stack/string limits without crashing the terminal.
    const note = unsupportedNote(e)
    if (!(e instanceof AwkError) && !(e instanceof RangeError) && !note) throw e
    exitCode = 2
    // Preserve output already produced when attaching a runtime diagnostic.
    if (e instanceof RangeError) gap = { detail: 'runtime limit', message: `awk: ${e.message}` }
    if (e.gap) gap = { detail: e.gap, message: `awk: ${e.message}` }
    if (note) gap = { detail: note.detail, message: `awk: ${e.message}` }
    m.errOut.push(gap === null ? `awk: ${where(m)}fatal: ${e.message}\n` : `awk: ${e.message}\n`)
  }
  // Standard input was taken whole as it was opened; what gawk had not read
  // of it by the time it was done goes back for whoever reads it next.
  m.input.settleStdin()
  const result = { stdout: m.out.join(''), stderr: m.errOut.join(''), exitCode }
  return gap === null ? result : markUnsupported(result, 'feature', 'awk', gap.detail, gap.message)
}

// What gawk prints when it gives up reading the program: the messages so
// far, then what stopped it — a syntax error as yyerror() shows one (exit
// 1), a fatal error (exit 2), or an error already among the messages.
function parseFailure(e, log, sources) {
  if (unsupportedNote(e)) return unsupportedFrom(e, 'awk', `awk: ${e.message}`)
  if (!(e instanceof AwkError)) throw e
  if (e.gap !== null) return unsupported('feature', 'awk', e.gap, `awk: ${e.message}`)
  return err(log.render(sources) + (e.text ?? ''), e.kind === 'fatal' ? 2 : 1)
}

// The program comes from `-f progfile` (several concatenate; `-` and
// /dev/stdin read standard input) or, failing that, the first operand.
function programSources(opts, stdin, ctx) {
  if (opts.files.length === 0) {
    if (opts.operands.length === 0) return { result: err(USAGE, 1) }
    return { sources: [{ name: null, text: opts.operands[0] }], operands: opts.operands.slice(1), stdin }
  }
  const sources = []
  let input = stdin
  for (const f of opts.files) {
    if (f === '-' || f === '/dev/stdin') {
      sources.push({ name: f, text: f === '/dev/stdin' && ctx.stdinFile ? ctx.stdinOrigin : input })
      input = ''
      consumeStdin(ctx)
      continue
    }
    const { path: abs, error } = lookupWithNote(ctx, 'awk', f)
    if (!error && ctx.fs.isDir(abs)) return { result: err(`awk: ${f}:1: error: cannot read source file \`${f}': Is a directory`, 1) }
    if (error) return { result: err(`awk: fatal: cannot open source file \`${f}' for reading: ${error}`, 2) }
    sources.push({ name: f, text: ctx.fs.readFile(abs) })
  }
  return { sources, operands: opts.operands, stdin: input }
}
