import { basename, lookup } from '../fs.js'
import { consumeStdin, err } from '../util.js'
import { unsupported } from '../unsupported.js'
import { lookupWithNote } from '../notes.js'
import { appendOutput, emptyOutput } from '../shell/output.js'
import { diffLines, sameLines } from '../diff/myers.js'
import { isBinary, lineKey, splitRecords, stripTrailingCr } from '../diff/compare.js'
import { renderDiff } from './diff-output.js'
import { parseDiffOptions } from './diff-options.js'
import { compareDirs } from './diff-dirs.js'

// diff: 0 when the files are the same, 1 when they differ, 2 for trouble.
// The change set is computed by src/diff/myers.js, which refuses to hand
// back one that does not reconstruct the second file; that refusal is
// reported here as trouble, on the feed, with no diff printed.
export function diff(stdin, tokens, ctx) {
  const parsed = parseDiffOptions(tokens)
  if (parsed.error) return parsed.error
  if (parsed.refused) return parsed.refused
  const { opts, operands } = parsed
  const state = { ctx, opts, stdin, out: emptyOutput(), status: 0, key: lineKey(opts) }
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
export function compareFiles(state, nameA, nameB, inDirectory) {
  const { opts } = state
  const sides = [nameA, nameB].map((name) => readOperand(state, name))
  const missing = sides.map((side) => side.content === null)
  const covered = opts.newFile && !(missing[0] && missing[1])
  let failed = false
  for (let i = 0; i < 2; i++) {
    if (!missing[i] || covered) continue
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
  const a = splitRecords(contents[0]), b = splitRecords(contents[1])
  if (sameLines(a, b, state.key)) return sameReport(state, nameA, nameB)
  if (opts.brief) return report(state, `Files ${label(0)} and ${label(1)} differ\n`, 1)
  let blocks
  try { blocks = diffLines(a, b, { key: state.key, minimal: opts.minimal }) } catch (e) {
    const message = `diff: ${nameA} ${nameB}: ${e.message}`
    appendOutput(state.out, unsupported('feature', 'diff', 'change set verification', message, 2))
    state.status = 2
    return
  }
  report(state, renderDiff(state, a, b, blocks, [nameA, nameB], missing, inDirectory), 1)
}

function sameReport(state, nameA, nameB) {
  if (state.opts.identical) report(state, `Files ${nameA} and ${nameB} are identical\n`)
}

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
