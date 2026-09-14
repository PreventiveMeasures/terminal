import { lookup, resolve } from '../fs.js'
import { consumeStdin, lineRecords } from '../util.js'
import { UnsupportedError, markUnsupported, unsupportedNote } from '../unsupported.js'
import { lookupWithNote } from '../notes.js'
import { PatchFatal, createScanner, nextHunk, scanHeaders } from './patch-parse.js'
import { chooseInput } from './patch-names.js'
import { applyHunks, createFileState, finishOutput, joinOutput } from './patch-apply.js'
import { createReject } from './patch-reject.js'
import { quoteShell } from './quote-name.js'
import { parsePatchOptions } from './patch-options.js'

// patch: apply a diff to the files it names. Messages go to stdout as GNU's
// do; a fatal error is `patch: **** …` on stderr with status 2; a hunk that
// did not apply is status 1, its text saved beside the file as a .rej.
// Files are written only inside a writable /tmp/ overlay; anywhere else the
// write is refused on the feed rather than pretended.
export function patch(stdin, tokens, ctx) {
  const parsed = parsePatchOptions(tokens)
  if (parsed.error) return parsed.error
  if (parsed.refused) return parsed.refused
  const { opts, operands } = parsed
  const run = { ctx, opts, dir: ctx.cwd, events: [], stdout: '', stderr: '', skipRest: false, skipRejectFile: false, reverse: opts.reverse, reverseFlag: opts.reverse, someFailed: false, rejectsMade: new Set(), output: '' }
  // With the result on stdout, what patch says goes to stderr, as GNU's does.
  const fd = opts.output === '-' ? 2 : 1
  run.quote = (name) => quoteShell(name, ctx)
  run.say = (text) => { if (fd === 1) run.stdout += text; else run.stderr += text; run.events.push({ fd, text }) }
  try {
    if (opts.directory !== null) {
      const found = lookup(ctx.cwd, opts.directory, ctx.fs)
      if (found.error || !ctx.fs.isDir(found.path)) throw new PatchFatal(`Can't change to directory ${quoteShell(opts.directory, ctx)} : ${found.error ?? 'Not a directory'}`)
      run.dir = found.path
    }
    const text = patchText(run, stdin, opts.input ?? operands[1] ?? null)
    applyAll(run, createScanner(text), operands[0] ?? null)
    if (opts.output !== null && opts.output !== '-') writeText(run, opts.output, run.output, false)
  } catch (e) {
    if (!(e instanceof PatchFatal)) {
      // A refusal keeps what was already said; anything else is dispatch's.
      const note = unsupportedNote(e)
      if (!note) throw e
      const message = `patch: ${e.message}`
      const result = { stdout: run.stdout, stderr: run.stderr + message + '\n', events: [...run.events, { fd: 2, text: message + '\n' }], exitCode: 2 }
      return markUnsupported(result, note.kind, 'patch', note.detail, message)
    }
    const message = `patch: **** ${e.message}\n`
    return { stdout: run.stdout, stderr: run.stderr + message, events: [...run.events, { fd: 2, text: message }], exitCode: 2 }
  }
  return { stdout: run.stdout, stderr: run.stderr, events: run.events, exitCode: run.someFailed ? 1 : 0 }
}

function patchText(run, stdin, source) {
  if (source === null) { consumeStdin(run.ctx); return stdin }
  if (source === '-') { consumeStdin(run.ctx); return stdin }
  const found = lookupWithNote(run.ctx, 'patch', source)
  if (found.error || run.ctx.fs.isDir(found.path)) throw new PatchFatal(`Can't open patch file ${quoteShell(source, run.ctx)} : ${found.error ?? 'Is a directory'}`)
  return run.ctx.fs.readFile(found.path)
}

// pch.c there_is_another_patch and the main loop of patch.c, one patch of
// the input at a time: find its headers, settle the file, apply its hunks,
// write the result, move on to the next.
function applyAll(run, scanner, operand) {
  const { opts } = run
  for (;;) {
    if (scanner.base !== 0 && scanner.base >= scanner.lines.length) return
    const header = scanHeaders(scanner, { needHeader: operand === null, strip: opts.strip, format: opts.format })
    if (header === null) {
      if (scanner.base === 0 && !scanner.empty) throw new PatchFatal('Only garbage was found in the patch input.')
      return
    }
    run.skipRest = false
    run.skipRejectFile = false
    run.reverse = run.reverseFlag
    let inname = chooseInput(run, header, operand, (name) => stat(run, name))
    if (inname === null) inname = askForFile(run, scanner, header)
    if (run.skipRest) run.someFailed = true
    scanner.pos = header.start
    applyOne(run, scanner, header, inname)
    scanner.base = scanner.pos
  }
}

function askForFile(run, scanner, header) {
  const { opts } = run
  if (!opts.silent) {
    run.say(`can't find file to patch at input line ${header.hunkLine + 1}\n`)
    if (header.type !== 'normal') run.say(opts.strip === -1 ? 'Perhaps you should have used the -p or --strip option?\n' : 'Perhaps you used the wrong -p or --strip option?\n')
  }
  if (scanner.base < header.start) {
    run.say('The text leading up to this was:\n--------------------------\n')
    for (let i = scanner.base; i < header.start; i++) run.say('|' + scanner.lines[i])
    run.say('--------------------------\n')
  }
  if (opts.force || opts.batch) run.say('No file to patch.  Skipping patch.\n')
  else {
    run.say('File to patch: \n')
    run.say('Skip this patch? [y] \n')
    if (!opts.silent) run.say('Skipping patch.\n')
  }
  run.skipRest = true
  return null
}

function applyOne(run, scanner, header, inname) {
  const { opts } = run
  const renaming = header.copy[0] || header.copy[1] || header.rename[0] || header.rename[1]
  let outname = null
  if (!run.skipRest) outname = opts.output ?? (renaming ? header.names[run.reverse ? 'old' : 'new'] : inname)
  let input = { exists: false, isDir: false, content: '' }
  if (!run.skipRest) {
    input = stat(run, inname)
    if (input.isDir) {
      run.say(`File ${quoteShell(inname, run.ctx)} is not a regular file -- refusing to patch\n`)
      run.skipRest = true
      run.someFailed = true
    }
  }
  if (!run.skipRest && !opts.dryRun && opts.output === null) {
    assertWritable(run, outname)
    if (renaming && inname !== outname) assertWritable(run, inname)
  }
  const state = createFileState(lineRecords(input.exists ? input.content : ''))
  if (!run.skipRest && !opts.silent) {
    const renamed = inname !== outname
    const skipRename = !renamed && (header.rename[0] || header.rename[1])
    const how = header.copy[0] || header.copy[1] ? 'copied' : header.rename[0] || header.rename[1] ? 'renamed' : 'read'
    const from = skipRename ? header.names[inname === header.names.old ? 'new' : 'old'] : inname
    const note = renamed || skipRename ? ` (${skipRename ? 'already ' : ''}${how} from ${from})` : ''
    run.say(`${opts.dryRun ? 'checking' : 'patching'} file ${quoteShell(outname, run.ctx)}${note}\n`)
  }
  const reject = createReject(header, opts.rejectFormat ?? header.type, run.reverse)
  const hunks = () => header.empty ? null : nextHunk(scanner, header.type)
  const result = applyHunks(run, header, hunks, state, reject)
  if (!run.skipRest && !finishOutput(state)) {
    run.say('misordered hunks! output would be garbled\nSkipping patch.\n')
    run.skipRest = true
  }
  const content = joinOutput(state.out)
  if (opts.output !== null && !run.skipRest) {
    if (opts.output === '-') { run.stdout += content; run.events.push({ fd: 1, text: content }) }
    else run.output += content
  }
  if (!run.skipRest && opts.output === null) store(run, header, { inname, outname, input, content, result, empty: state.out.length === 0, renaming })
  if (result.failed && !run.skipRejectFile) reportRejects(run, outname, result, reject.text)
}

// The end of patch.c's per-file loop: delete a file the patch empties out,
// or write it, with a backup when asked or when a hunk did not fit exactly.
function store(run, header, file) {
  const { opts } = run
  const { inname, outname, input, content, result, empty, renaming } = file
  const backup = opts.backup || (opts.backupIfMismatch && (result.mismatch || result.failed > 0))
  const saysDeleted = header.says[run.reverse ? 0 : 1] === 2
  if (empty && (opts.removeEmpty || saysDeleted)) {
    if (!opts.dryRun) removeFile(run, outname, backup)
    return
  }
  if (!empty && saysDeleted) {
    run.someFailed = true
    if (!opts.silent) run.say(`Not deleting file ${quoteShell(outname, run.ctx)} as content differs from patch\n`)
  }
  if (opts.dryRun) return
  if (result.failed < result.count || renaming) {
    writeText(run, outname, content, backup)
    if (renaming && inname !== outname && (header.rename[0] || header.rename[1])) removeFile(run, inname, false)
  } else if (backup) {
    if (!input.exists) throw new PatchFatal(`Can't reopen file ${quoteShell(outname, run.ctx)} : No such file or directory`)
    writeText(run, backupName(run, outname), input.content, false)
  }
}

function reportRejects(run, outname, result, text) {
  const { opts } = run
  run.someFailed = true
  run.say(`${result.failed} out of ${result.count} hunk${result.count === 1 ? '' : 's'} ${run.skipRest ? 'ignored' : 'FAILED'}`)
  if (outname === null || opts.rejectFile === '-') { run.say('\n'); return }
  const rej = opts.rejectFile ?? outname + '.rej'
  if (opts.dryRun) { run.say('\n'); return }
  run.say(` -- saving rejects to file ${quoteShell(rej, run.ctx)}\n`)
  assertWritable(run, rej)
  const seen = run.rejectsMade.has(resolve(run.dir, rej))
  run.rejectsMade.add(resolve(run.dir, rej))
  const existing = seen ? stat(run, rej).content : ''
  writeText(run, rej, existing + text, false)
}

const backupName = (run, name) => name + run.opts.suffix

function stat(run, name) {
  const found = lookup(run.dir, name, run.ctx.fs)
  if (found.error) return { exists: false, isDir: false, size: 0, content: '' }
  if (run.ctx.fs.isDir(found.path)) return { exists: true, isDir: true, size: 0, content: '' }
  const content = run.ctx.fs.readFile(found.path)
  return { exists: true, isDir: false, size: content.length, content }
}

// Only the /tmp/ overlay takes writes; the source tree never does.
function assertWritable(run, name) {
  const path = resolve(run.dir, name)
  if (run.ctx.writable && path.startsWith('/tmp/')) return
  throw new UnsupportedError('feature', 'read-only target', `${name}: file system is read-only`)
}

function writeText(run, name, content, backup) {
  const { ctx } = run
  assertWritable(run, name)
  const found = lookup(run.dir, name, ctx.fs)
  try {
    if (!found.error) {
      ctx.fs.replaceWritable(run.dir, name, content, backup ? backupName(run, name) : undefined)
      return
    }
    if (backup) ctx.fs.openWritable(run.dir, backupName(run, name))
    ctx.fs.openWritable(run.dir, name).write(content)
  } catch (e) {
    throw new PatchFatal(`Can't create file ${quoteShell(name, run.ctx)} : ${e?.fsError ?? e.message}`)
  }
}

function removeFile(run, name, backup) {
  const { ctx } = run
  assertWritable(run, name)
  const current = stat(run, name)
  if (!current.exists) return
  if (backup) ctx.fs.openWritable(run.dir, backupName(run, name)).write(current.content)
  ctx.fs.removeWritable(run.dir, name)
}
