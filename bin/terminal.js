#!/usr/bin/env node
// Development REPL over a real directory: read every file under it into
// memory once, then run the virtual terminal over that snapshot, mounted at
// the directory's own resolved path so paths read exactly as they do on the
// host. Nothing else on the host is visible, and nothing is written back —
// the snapshot is read-only and /tmp/ is an in-memory overlay.
// Not part of the published package; run it as `bin/terminal.js <dir>`.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { createTerminal } from '@preventive/terminal'
import process from 'node:process'
import repl from 'node:repl'
import { TextDecoder, styleText } from 'node:util'

const USAGE = `Usage: bin/terminal.js <path-to-dir>

Reads every file under <path-to-dir> into memory and opens a REPL running the
virtual terminal over that snapshot, mounted at the directory's own resolved
path. Nothing else on the host is visible and nothing is written back: the
snapshot is read-only, and /tmp/ is an in-memory overlay that lasts for the
session only.

Files that are not valid UTF-8 are left out, as are symlinks and anything that
is not a regular file; \`.info\` lists what was skipped. Directories exist only
where files do, so empty ones are not part of the tree. The mounted directory
doubles as the session's home, so \`~\` and a bare \`cd\` return to it.

  -h, --help   show this message
`

// Exit only on a line that is nothing but the builtin, so composed uses
// (`exit 1 && echo no`) keep their emulated meaning inside the session.
const EXIT_LINE = /^\s*exit(?:\s+[+-]?\d+)?\s*$/u
const OMISSION_LIMIT = 10
const REASONS = {
  EACCES: 'permission denied',
  ELOOP: 'too many levels of symbolic links',
  ENOENT: 'no such file or directory',
  EPERM: 'operation not permitted',
  ERR_FS_FILE_TOO_LARGE: 'too large to read into memory',
}

function main(argv) {
  if (argv[0] === '-h' || argv[0] === '--help') { process.stdout.write(USAGE); return }
  if (argv.length !== 1 || argv[0] === '') fail(USAGE)
  const root = directoryAt(argv[0])
  const mount = posix(root)
  const tree = readTree(root)
  // The overlay refuses a mount that would collide with it; the tree is the
  // point of the session, so keep it and report the overlay as unavailable.
  const writable = mount === '/' || mount === '/tmp' || mount.startsWith('/tmp/') ? false : '/tmp/'
  // Home is the mounted directory: it is the only tree that exists here, so `~`
  // always resolves, a bare `cd` returns to the root of it, and the prompt stays
  // short however deep the host path is.
  const options = { mount, cwd: mount, home: mount, writable, user: safely(() => userInfo().username, 'user') }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  start({ terminal: createTerminal(tree.sources, options), tree, mount, home: mount, writable, interactive, exitCode: 0, closing: false })
}

function directoryAt(arg) {
  let path
  // The mount is where the directory really lives, symlinked components and all.
  try { path = realpathSync(resolve(arg)) } catch (e) { return fail(`terminal.js: ${arg}: ${reasonOf(e)}\n`) }
  if (!statSync(path).isDirectory()) return fail(`terminal.js: ${arg}: not a directory\n`)
  return path
}

// One iterative pass; the virtual FS sorts what it is given, so traversal
// order does not matter. Symlinks are never followed: the virtual FS has no
// link concept, and a link can point outside the directory being mounted.
function readTree(root) {
  const decoder = new TextDecoder('utf8', { fatal: true, ignoreBOM: true })
  const sources = new Map()
  const omitted = []
  const stack = [root]
  let bytes = 0
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (e) { omitted.push({ path: dir, reason: reasonOf(e) }); continue }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { stack.push(path); continue }
      if (!entry.isFile()) { omitted.push({ path, reason: entry.isSymbolicLink() ? 'symbolic link' : 'not a regular file' }); continue }
      let data
      try { data = readFileSync(path) } catch (e) { omitted.push({ path, reason: reasonOf(e) }); continue }
      const text = decode(decoder, data)
      // A string-based terminal cannot carry bytes it could not print back.
      if (text === null) { omitted.push({ path, reason: 'not valid UTF-8' }); continue }
      sources.set(posix(relative(root, path)), text)
      bytes += data.length
    }
  }
  return { sources, omitted, bytes }
}

function start(session) {
  const hint = styleText('gray', '.help for REPL commands, .info for what is mounted, exit to leave', { stream: process.stderr })
  if (session.interactive) note(`${banner(session)}\n${hint}`)
  else if (!session.writable) note(overlayLine(session))
  const server = repl.start({
    prompt: prompt(session, session.terminal.cwd()),
    eval: (line, context, file, callback) => evaluate(session, server, line, callback),
    completer: (line) => complete(session.terminal, line),
    writer: () => '',
    ignoreUndefined: true,
    terminal: session.interactive,
  })
  // A piped session is a batch of commands, so stdout stays what they wrote:
  // no prompt, and none of the `| ` the REPL prints while collecting a
  // continued line.
  if (!session.interactive) server.displayPrompt = () => {}
  for (const name of ['break', 'clear', 'load', 'save']) delete server.commands[name]
  server.defineCommand('info', {
    help: 'Show what is mounted and what was left out',
    action() { note(banner(session) + omissions(session.tree)); this.displayPrompt() },
  })
  // Report the session's own status the way a shell reports its last command.
  server.on('exit', () => { process.exitCode = session.exitCode })
}

function evaluate(session, server, input, callback) {
  // Lines already buffered from a pipe still arrive after a close.
  if (session.closing) return callback(null)
  // In a terminal, readline returns a multiline entry with its lines joined by
  // a carriage return. The shell reads `\\` before one as an escaped CR rather
  // than as the continuation that was typed, so put the newlines back.
  const line = input.replace(/\n$/u, '').replaceAll('\r', '\n')
  // A trailing backslash is the shell's own continuation: collect the next
  // line and hand the tokenizer the whole thing, newline included.
  if (trailingBackslashes(line) % 2 === 1) return callback(new repl.Recoverable(new Error('line continuation')))
  if (line.trim() === '') return callback(null)
  const result = attempt(() => session.terminal.run(line))
  if (!result) return callback(null)
  session.exitCode = result.exitCode
  report(session, result)
  if (EXIT_LINE.test(line)) { session.closing = true; server.close() }
  else server.setPrompt(prompt(session, result.cwd))
  callback(null)
}

// Streams first, exactly as the command wrote them, then the two channels no
// redirect inside the line could have suppressed, then the status.
function report(session, result) {
  write(session, process.stdout, result.stdout)
  write(session, process.stderr, result.stderr)
  for (const gap of result.unsupported) note(styleText('red', `UNSUPPORTED: ${gap.message}`, { stream: process.stderr }))
  for (const text of result.notes) note(styleText('gray', `NOTE: ${text}`, { stream: process.stderr }))
  if (result.exitCode !== 0) note(styleText('gray', `[exit ${result.exitCode}]`, { stream: process.stderr }))
}

// Output need not end in a newline (`printf hi`). Keep it byte-exact when the
// session is piped somewhere, and keep the prompt on its own line when it is not.
function write(session, stream, text) {
  if (text === '') return
  stream.write(session.interactive && !text.endsWith('\n') ? text + '\n' : text)
}

// complete() returns whole-line replacements, and readline inserts the part of
// a hit past the prefix it was given — so any shared cut works, and cutting at
// the last separator lists the words alone rather than repeating the line.
function complete(terminal, line) {
  const hits = attempt(() => terminal.complete(line)) ?? []
  if (hits.length < 2) return [hits, line]
  const cut = Math.max(...[...' \t/|;&(<>'].map((c) => line.lastIndexOf(c))) + 1
  return [hits.map((hit) => hit.slice(cut)), line.slice(cut)]
}

function banner(session) {
  const { sources, omitted, bytes } = session.tree
  const left = omitted.length === 0 ? '' : `, ${omitted.length} omitted (${reasonCounts(omitted)})`
  return [
    `${session.mount} mounted from the host: ${sources.size} files, ${size(bytes)}${left}`,
    overlayLine(session),
  ].join('\n')
}

const overlayLine = (session) => session.writable
  ? 'writable in-memory overlay at /tmp/'
  : 'no writable overlay: it needs a mount that is neither / nor inside /tmp/'

function omissions({ omitted }) {
  if (omitted.length === 0) return ''
  const shown = omitted.slice(0, OMISSION_LIMIT).map(({ path, reason }) => `\n  ${path}: ${reason}`).join('')
  return `\nleft out:${shown}${omitted.length > OMISSION_LIMIT ? `\n  … and ${omitted.length - OMISSION_LIMIT} more` : ''}`
}

function prompt(session, cwd) {
  if (!session.interactive) return ''
  const home = session.home
  const inHome = home !== '/' && (cwd === home || cwd.startsWith(home + '/'))
  return styleText('cyan', inHome ? '~' + cwd.slice(home.length) : cwd, { stream: process.stdout }) + '$ '
}

// run() and complete() report their own failures; anything thrown is a bug in
// the terminal itself, which a session being used to find bugs should show.
const attempt = (call) => {
  try { return call() } catch (e) { note(styleText('red', `INTERNAL: ${e?.stack ?? e}`, { stream: process.stderr })); return null }
}

const decode = (decoder, data) => { try { return decoder.decode(data) } catch { return null } }
const fail = (message) => { process.stderr.write(message); process.exit(2) }
const note = (text) => process.stderr.write(text + '\n')
const posix = (path) => path.split(sep).join('/')
const reasonOf = (e) => REASONS[e?.code] ?? e?.message ?? 'unreadable'
const safely = (read, fallback) => { try { return read() } catch { return fallback } }
const trailingBackslashes = (line) => /\\*$/u.exec(line)[0].length

function reasonCounts(omitted) {
  const counts = new Map()
  for (const { reason } of omitted) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  return [...counts].map(([reason, count]) => `${count} ${reason}`).join(', ')
}

function size(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let n = bytes
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++ }
  return `${unit === 0 ? n : n.toFixed(1)} ${units[unit]}`
}

// Helpers above are hoisted or initialized by the time the entry point runs.
main(process.argv.slice(2))
