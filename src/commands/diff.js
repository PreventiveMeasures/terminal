import { DiffError, FormatError, diff as diffText } from '@preventive/diff'
import { basename, lookup } from '../fs.js'
import { consumeStdin, err } from '../util.js'
import { unsupported } from '../unsupported.js'
import { lookupWithNote } from '../notes.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { renderDiff } from './diff-output.js'
import { parseDiffOptions } from './diff-options.js'
import { compareDirs } from './diff-dirs.js'

// diff: 0 when the files are the same, 1 when they differ, 2 for trouble.
// The diff itself comes from @preventive/diff, which refuses to hand back a
// change set that does not reconstruct the second file, or a rendering that
// does not say what the change set says; either refusal is reported here as
// trouble, on the feed, with no diff printed.
export function diff(stdin, tokens, ctx) {
  const parsed = parseDiffOptions(tokens)
  if (parsed.error) return parsed.error
  if (parsed.refused) return parsed.refused
  const { opts, operands } = parsed
  const state = { ctx, opts, stdin, out: emptyOutput(), status: 0 }
  const [left, right] = operands
  const kinds = operands.map((name) => operandKind(state, name))
  // One directory named twice is one physical file to GNU: nothing to compare.
  if (kinds[0] === 'dir' && kinds[1] === 'dir' && samePath(state, left, right)) return state.out
  if (kinds[0] === 'dir' && kinds[1] === 'dir') compareDirs(state, left, right)
  else if (kinds[0] === 'dir' || kinds[1] === 'dir') {
    // GNU: a directory beside a file means the file of that name inside it.
    const dirSide = kinds[0] === 'dir' ? 0 : 1
    const file = operands[1 - dirSide]
    if (file === '-') return err("diff: cannot compare '-' to a directory", 2)
    const inside = joinName(operands[dirSide], basename(file))
    const pair = dirSide === 0 ? [inside, file] : [file, inside]
    if (operandKind(state, inside) === 'missing') report(state, `diff: ${inside}: No such file or directory\n`, 2, true)
    else compareFiles(state, pair[0], pair[1], false)
  } else compareFiles(state, left, right, false)
  state.out.exitCode = state.status
  return state.out
}

// gnulib file_name_concat: a slash goes between, however many the directory ends in.
export function joinName(dir, name) {
  const trimmed = dir.replace(/\/+$/u, '')
  return (trimmed === '' ? '/' : trimmed + '/') + name
}

function samePath(state, a, b) {
  return lookup(state.ctx.cwd, a, state.ctx.fs).path === lookup(state.ctx.cwd, b, state.ctx.fs).path
}

function operandKind(state, name) {
  if (name === '-') return 'stdin'
  const found = lookup(state.ctx.cwd, name, state.ctx.fs)
  if (found.error) return 'missing'
  return state.ctx.fs.isDir(found.path) ? 'dir' : 'file'
}

export function report(state, text, status = 0, stderr = false) {
  appendOutput(state.out, stderr ? emptyOutput(text) : { ...emptyOutput(), stdout: text, events: [{ fd: 1, text }] })
  state.status = Math.max(state.status, status)
}

// Two file operands, `inDirectory` when a directory walk paired them. A
// missing file is an error unless -N stands in an empty file for it, and
// then only inside a directory or beside a file that does exist.
// `listed` is what a directory comparison knows and an operand does not: which
// side the listing held. `-N` stands in for a name a directory does not have,
// and never for one it has and cannot read — a link leading nowhere is there,
// and GNU says so rather than diffing it as the empty file it is not. Two
// operands have no listing behind them, so ENOENT is absence there, and `-N`
// covers it unless it is all either of them is.
export function compareFiles(state, nameA, nameB, inDirectory, listed = null) {
  const { opts } = state
  const sides = [nameA, nameB].map((name) => readOperand(state, name))
  const missing = sides.map((side) => side.content === null)
  const covered = opts.newFile && !(missing[0] && missing[1])
  let failed = false
  for (let i = 0; i < 2; i++) {
    if (!missing[i] || (listed ? !listed[i] : covered)) continue
    report(state, `diff: ${[nameA, nameB][i]}: No such file or directory\n`, 2, true)
    failed = true
  }
  if (failed) return
  if (sides[0].identity !== undefined && sides[0].identity === sides[1].identity && !missing[0]) return sameReport(state, nameA, nameB)
  let contents = sides.map((side) => side.content ?? '')
  if (opts.stripCr) contents = contents.map(stripTrailingCr)
  const label = (i) => opts.labels[i] ?? [nameA, nameB][i]
  if (!opts.text && contents.some(isBinary)) {
    if (contents[0] === contents[1]) return sameReport(state, nameA, nameB)
    return report(state, `${opts.brief ? 'Files' : 'Binary files'} ${label(0)} and ${label(1)} differ\n`, 1)
  }
  // -q asks whether they differ at all, which the library answers by one
  // pass that stops at the first line that differs, where a diff would go on
  // to find the shortest way to describe them all.
  if (opts.brief) {
    if (diffText(contents[0], contents[1], { format: 'brief', ignoreCase: opts.ignoreCase, whitespace: opts.whitespace }) === '') return sameReport(state, nameA, nameB)
    return report(state, `Files ${label(0)} and ${label(1)} differ\n`, 1)
  }
  let text
  try { text = renderDiff(state, contents, [nameA, nameB], missing, inDirectory) } catch (e) {
    if (!(e instanceof DiffError) && !(e instanceof FormatError)) throw e
    const message = `diff: ${nameA} ${nameB}: ${e.message}`
    const detail = e instanceof DiffError ? 'change set verification' : 'diff rendering verification'
    appendOutput(state.out, unsupported('feature', 'diff', detail, message, 2))
    state.status = 2
    return
  }
  // Nothing to print is the answer that they match; asking twice would mean
  // searching twice, since that search is the only thing that can say so.
  if (text === '') return sameReport(state, nameA, nameB)
  report(state, text, 1)
}

function sameReport(state, nameA, nameB) {
  if (state.opts.identical) report(state, `Files ${nameA} and ${nameB} are identical\n`)
}

// --strip-trailing-cr edits the text before it is compared, so the output
// shows the stripped lines too, as GNU's does.
const stripTrailingCr = (text) => text.replace(/\r\n/gu, '\n')

// GNU looks for a NUL in the first block it reads; a file this size is read
// whole, so the whole file is what is looked at.
const isBinary = (text) => text.includes('\0')

// Content null means the file is not there. Identity tells `diff a ./a`
// apart from two files that merely read the same.
function readOperand(state, name) {
  const { ctx } = state
  if (name === '-') {
    consumeStdin(ctx)
    return { content: state.stdin, identity: ctx.stdinHandle?.identity ?? Symbol('stdin') }
  }
  const found = lookupWithNote(ctx, 'diff', name)
  if (found.error || ctx.fs.isDir(found.path)) return { content: null, identity: undefined }
  return { content: ctx.fs.readFile(found.path), identity: ctx.fs.fileIdentity?.(found.path) ?? found.path }
}
