import { lookupWithNote } from '../notes.js'
import { UnsupportedError, unsupported } from '../unsupported.js'
import { err, ok, readFilesFor } from '../util.js'
import { SED_USAGE, panic, sedFailure } from './sed-common.js'
import { runInPlace } from './sed-in-place.js'
import { refreshSedStdin, sedOutput } from './sed-output.js'
import { commandReader } from './sed-files.js'
import { runSed } from './sed-run.js'
import { compileFile, compileString, createCompiler, finishProgram } from './sed-script.js'

export function sed(stdin, tokens, ctx) {
  try {
    return run(stdin, tokens, ctx)
  } catch (e) { return sedFailure(e) }
}

function run(stdin, tokens, ctx) {
  const { actions, positional } = readOptions(tokens)
  const closed = ctx.outputFds?.[1] === 'closed'
  const options = { quiet: false, separate: false, delimiter: '\n', inPlace: null, lineLength: null, sandbox: false }
  // The w files open as the scripts are read, into the output the run uses.
  // A later -z still sets the delimiter they write and read by.
  let output = null
  const delimiter = () => options.delimiter
  const outputFor = () => (output ??= sedOutput(ctx, delimiter))
  const readers = new Map()
  const compiler = createCompiler({
    locale: ctx.locale,
    openWrite: (name) => outputFor().openWrite(name),
    openRead: (name) => {
      // An R file open from the start takes a closed stdout's descriptor.
      if (outputFor().closed) throw new UnsupportedError('feature', 'closed stdout', 'sed: opening an R file while stdout is closed is not supported')
      if (!readers.has(name)) readers.set(name, commandReader(ctx, outputFor(), name, delimiter))
      return readers.get(name)
    },
  })
  let scripted = false
  // GNU compiles each script as getopt reaches its option, so a later -E
  // reads only the scripts after it, and a fault in one stops the rest.
  for (const { name, value, error, unknown } of actions) {
    // An option sed does not have is reported as one this terminal lacks.
    if (unknown) return unsupported('option', 'sed', unknown, `sed: unknown option: ${unknown}`)
    if (error !== undefined) return usageFailure(error, closed)
    switch (name) {
      case 'n': options.quiet = true; break
      case 'e':
        compileString(compiler, value)
        scripted = true
        break
      case 'f':
        stdin = compileScriptFile(compiler, value, stdin, ctx)
        scripted = true
        break
      case 'z': options.delimiter = '\0'; break
      case 'i': options.inPlace = value ?? ''; options.separate = true; break
      case 'l': options.lineLength = atoi(value); break
      case 'r': compiler.extended = true; break
      case 's': options.separate = true; break
      case 'b': break
      case 'sandbox': compiler.sandbox = true; break
      case 'help':
        if (closed) return err("sed: couldn't close stdout: Bad file descriptor", 4)
        return ok(SED_USAGE + 'E-mail bug reports to: <bug-sed@gnu.org>.\n')
      case 'V': return usageFailure('', closed)
      default: {
        const spelling = name.length === 1 ? `-${name}` : `--${name}`
        return unsupported('option', 'sed', spelling, `sed: unknown option: ${spelling}`)
      }
    }
  }
  let files = positional
  if (!scripted) {
    if (positional.length === 0) return usageFailure('', closed)
    compileString(compiler, positional[0])
    files = positional.slice(1)
  }
  const { commands, quiet, badProg } = finishProgram(compiler)
  if (options.inPlace !== null && files.length === 0) throw panic('no input files')
  const program = {
    commands, badProg, files, stdin: refreshSedStdin(stdin, ctx), output: outputFor(),
    delimiter: options.delimiter, quiet: options.quiet || quiet, separate: options.separate,
    hold: { text: '', terminator: options.delimiter }, regexState: { last: null },
    lineLength: options.lineLength ?? 70, colsSet: options.lineLength === null && ctx.vars?.has('COLS'),
  }
  return options.inPlace === null ? runSed(program, ctx) : runInPlace(program, ctx, options.inPlace)
}

// usage(): a message, if getopt had one, then GNU's usage text, status 1 —
// and as it exits through ck_fclose, a closed stdout's failure.
function usageFailure(message, closed) {
  const stderr = (message ? `sed: ${message}\n` : '') + SED_USAGE
  return closed ? err(`${stderr}sed: couldn't close stdout: Bad file descriptor`, 4) : err(stderr, 1)
}

// A script file is read whole as it is named; one that cannot be opened is a
// panic, and a directory, which fopen opens and getc reads nothing from, is
// an empty script.
function compileScriptFile(compiler, name, stdin, ctx) {
  let input = stdin
  if (name !== '-' && name !== '/dev/stdin') {
    const found = lookupWithNote(ctx, 'sed', name)
    if (found.error) throw panic(`couldn't open file ${name}: ${found.error}`)
    if (ctx.fs.isDir(found.path)) {
      compileFile(compiler, name, '')
      return input
    }
  }
  input = refreshSedStdin(input, ctx)
  const scriptInput = input
  const r = ctx.io.bufferReads(() => readFilesFor('sed', [name], ctx, scriptInput))
  if (r.failed) throw panic(`couldn't open file ${name}: ${r.stderr.slice(r.stderr.lastIndexOf(': ') + 2).trimEnd()}`)
  if (r.inputs[0].shared) input = ''
  compileFile(compiler, name, r.inputs[0].content)
  return input
}

// atoi: leading blanks, a sign and digits; anything else reads as 0.
function atoi(text) {
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)/u.exec(text)
  return m ? Number(BigInt.asIntN(32, BigInt(m[1]))) : 0
}

// GNU sed's getopt_long, permuting operands to the end: SHORTOPTS
// "bsnrzuEe:f:l:i::V:" and its long options, abbreviations included. An
// option is an action, run in order; getopt's own complaint is the last.
const SHORT = { b: 0, s: 0, n: 0, r: 0, z: 0, u: 0, E: 0, e: 1, f: 1, l: 1, i: 2, V: 1 }
const LONG = [
  ['binary', 0, 'b'], ['regexp-extended', 0, 'r'], ['debug', 0, 'debug'], ['expression', 1, 'e'], ['file', 1, 'f'],
  ['in-place', 2, 'i'], ['line-length', 1, 'l'], ['null-data', 0, 'z'], ['zero-terminated', 0, 'z'], ['quiet', 0, 'n'],
  ['posix', 0, 'posix'], ['silent', 0, 'n'], ['sandbox', 0, 'sandbox'], ['separate', 0, 's'], ['unbuffered', 0, 'u'],
  ['version', 0, 'version'], ['help', 0, 'help'], ['follow-symlinks', 0, 'follow-symlinks'],
]

export function readOptions(tokens) {
  const actions = []
  const positional = []
  const fail = (error, unknown) => { actions.push({ error, unknown }); return { actions, positional } }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--') { positional.push(...tokens.slice(i + 1)); break }
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      const spelt = eq < 0 ? body : body.slice(0, eq)
      let found = LONG.find(([long]) => long === spelt)
      if (!found) {
        const candidates = LONG.filter(([long]) => long.startsWith(spelt))
        if (candidates.length === 0) return fail(`unrecognized option '--${body}'`, `--${spelt}`)
        const [first] = candidates
        const ambiguous = candidates.filter((option) => option === first || option[1] !== first[1] || option[2] !== first[2])
        if (ambiguous.length > 1) return fail(`option '--${body}' is ambiguous; possibilities:${ambiguous.map(([long]) => ` '--${long}'`).join('')}`, `--${spelt}`)
        found = first
      }
      const [long, hasArg, name] = found
      if (eq >= 0) {
        if (hasArg === 0) return fail(`option '--${long}' doesn't allow an argument`)
        actions.push({ name, value: body.slice(eq + 1) })
      } else if (hasArg === 1) {
        if (i + 1 >= tokens.length) return fail(`option '--${long}' requires an argument`)
        actions.push({ name, value: tokens[++i] })
      } else actions.push({ name, value: null })
      continue
    }
    if (!token.startsWith('-') || token === '-') { positional.push(token); continue }
    for (let j = 1; j < token.length; j++) {
      const option = token[j]
      if (!Object.hasOwn(SHORT, option)) return fail(`invalid option -- '${option}'`, `-${option}`)
      const rest = token.slice(j + 1)
      if (SHORT[option] === 0) { actions.push({ name: option === 'E' ? 'r' : option, value: null }); continue }
      if (SHORT[option] === 2) actions.push({ name: option, value: rest === '' ? null : rest })
      else if (rest !== '') actions.push({ name: option, value: rest })
      else if (i + 1 < tokens.length) actions.push({ name: option, value: tokens[++i] })
      else return fail(`option requires an argument -- '${option}'`)
      break
    }
  }
  return { actions, positional }
}
