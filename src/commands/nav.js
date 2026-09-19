// Commands that navigate or query the virtual filesystem.

import { compareNames, lookup, resolve } from '../fs.js'
import { longFormat } from './ls-long.js'
import { tree } from './tree.js'
import { find } from './find.js'
import { homeOf } from '../shell/expand.js'
import { parseArgs } from '../args.js'
import { err, ok, usage } from '../util.js'
import { unsupported } from '../unsupported.js'
import { hiddenEntryNotes, lookupWithNote } from '../notes.js'
import { FS_TOOLS } from './fs-tools.js'

function pwd(_stdin, tokens, ctx) {
  parseArgs(tokens)
  return ok(ctx.cwd + '\n')
}

// A successful cd updates PWD and OLDPWD; cd - also prints the destination.
function cd(_stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  if (positional.length > 1) return err('cd: too many arguments')
  if (!positional.length && ctx.vars.unsetNames.has('HOME')) return err('cd: HOME not set')
  let target = positional[0] ?? homeOf(ctx)
  if (target === '-') {
    if (!ctx.vars.has('OLDPWD')) return err('cd: OLDPWD not set')
    target = ctx.vars.get('OLDPWD')
  }
  const printed = positional[0] === '-' ? target + '\n' : ''
  if (target === '') return ok(printed)
  const { path: abs, error } = lookupWithNote(ctx, 'cd', target)
  if (error) return err(`cd: ${target}: ${error}`)
  if (!ctx.fs.isDir(abs)) return err(`cd: ${target}: Not a directory`)
  // Bash keeps the name it was given in PWD, links and all, and collapses a
  // later `..` in it rather than in the path it leads to — the logical
  // directory `cd -L` means and `pwd` prints. Nothing here holds a working
  // directory that is not the one on the filesystem, so a path that crosses a
  // link is refused rather than answered as `cd -P` would answer it. A walk
  // that crossed none leaves the same path lexical normalization does.
  if (abs !== resolve(ctx.cwd, target)) {
    return unsupported('feature', 'cd', 'symbolic link cwd', `cd: ${target}: a working directory reached through a symbolic link is not supported (it leads to ${abs})`)
  }
  ctx.vars.set('OLDPWD', ctx.cwd)
  ctx.vars.set('PWD', abs)
  ctx.cwd = abs
  return ok(printed)
}

// What `-F` marks each kind with: nothing here is executable, a socket or a
// pipe, so `/` and `@` are the whole of it.
const MARKS = { dir: '/', link: '@', file: '' }

// Non-TTY ls: one name per line, lexical order, classification only with
// -F. A long listing is the model in ls-long.js, since a path-to-content
// filesystem has no metadata of its own to print.
function ls(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['1', 'l', 'a', 'A', 'R', 'd', 'r', 'F', 'h'] })
  const long = flags.has('l') ? longFormat(ctx, flags.has('h')) : null
  const targets = (positional.length ? positional : ['.']).toSorted(compareNames)
  if (flags.has('r')) targets.reverse()
  const dirs = [], errors = [], files = []
  const hidden = hiddenEntryNotes()
  const all = flags.has('a') || flags.has('A')
  const kindOf = (abs) => ctx.fs.isDir(abs) ? 'dir' : ctx.fs.isLink?.(abs) ? 'link' : 'file'
  const indicator = (kind) => flags.has('F') ? MARKS[kind] : ''
  // A file operand and a directory entry are the same row: what it was called,
  // what to print for it, where it is, what it is, and — for a link, which a
  // long listing names beside what it points at — the target it holds. Once a
  // row names both, the mark goes on the target rather than on the link, and
  // on the target as it was written, trailing slash and all: GNU marks the
  // name it printed, and only an operand's own spelling keeps it from doubling.
  const entry = (raw, abs, kind) => ({
    raw, abs, kind,
    name: kind === 'link' && long ? raw : raw + (raw.endsWith('/') ? '' : indicator(kind)),
    target: kind === 'link' ? ctx.fs.readLink(abs) + indicator(kindOf(lookup(ctx.cwd, abs, ctx.fs).path ?? '')) : null,
  })
  const render = (entries, listing) => long ? long.lines(entries, listing) : entries.map((e) => e.name)
  // `ls link` lists what a link names when the link leads to a directory, and
  // `-l`, `-F` and `-d` describe the link itself instead, as GNU's own
  // dereferencing defaults have it. Either way the name printed is the operand.
  const followOperand = !(flags.has('l') || flags.has('F') || flags.has('d'))
  for (const target of targets) {
    const { path: abs, error } = lookupWithNote(ctx, 'ls', target, { follow: false })
    const followed = error || !followOperand || !ctx.fs.isLink?.(abs) ? abs : lookup(ctx.cwd, target, ctx.fs).path
    if (error) errors.push(`ls: cannot access '${target}': ${error}`)
    else if (flags.has('d') || ctx.fs.isFile(abs) || !ctx.fs.isDir(followed)) files.push(entry(target, abs, kindOf(abs)))
    else dirs.push({ path: target, abs: followed })
  }
  const blocks = files.length ? [render(files, false).join('\n')] : []
  for (const target of dirs) {
    const stack = [target]
    while (stack.length) {
      const { path, abs } = stack.pop()
      const listed = ctx.fs.listDir(abs)
      if (!all) hidden.collect(abs, [...listed.dirs, ...listed.files, ...listed.links])
      const shown = (names, kind) => names.filter((name) => all || !name.startsWith('.')).map((name) => entry(name, resolve(abs, name), kind))
      const entries = [...shown(listed.dirs, 'dir'), ...shown(listed.files, 'file'), ...shown(listed.links, 'link')]
      if (flags.has('a')) entries.push(entry('.', abs, 'dir'), entry('..', resolve(abs, '..'), 'dir'))
      entries.sort((a, b) => compareNames(a.raw, b.raw))
      if (flags.has('r')) entries.reverse()
      const rows = render(entries, true)
      if (targets.length > 1 || flags.has('R')) rows.unshift(path + ':')
      if (rows.length) blocks.push(rows.join('\n'))
      if (!flags.has('R')) continue
      for (const e of entries.toReversed()) {
        if (e.raw === '.' || e.raw === '..' || !ctx.fs.isDir(e.abs)) continue
        stack.push({ path: path.endsWith('/') ? path + e.raw : path + '/' + e.raw, abs: e.abs })
      }
    }
  }
  hidden.emit(ctx.notes, 'ls', 'Hidden entries are included with -a.')
  return { stdout: blocks.length ? blocks.join('\n\n') + '\n' : '', stderr: errors.length ? errors.join('\n') + '\n' : '', exitCode: errors.length ? 2 : 0 }
}

// Strip a matching suffix only when it leaves part of the basename intact.
function basenameCmd(_stdin, tokens) {
  const { positional } = parseArgs(tokens)
  if (positional.length === 0) return usage('basename PATH [SUFFIX]')
  if (positional.length > 2) return err(`basename: extra operand: ${positional[2]}`)
  const path = positional[0].replace(/\/+$/u, '')
  const name = path === '' ? (positional[0] === '' ? '' : '/') : path.slice(path.lastIndexOf('/') + 1)
  return ok(stripSuffix(name, positional[1]) + '\n')
}

function stripSuffix(name, suffix) {
  if (!suffix || suffix === name || !name.endsWith(suffix)) return name
  return name.slice(0, -suffix.length)
}

function dirnameCmd(_stdin, tokens) {
  const { positional } = parseArgs(tokens)
  if (positional.length === 0) return usage('dirname PATH')
  return ok(positional.map((p) => {
    const path = p.replace(/\/+$/u, '')
    const i = path.lastIndexOf('/')
    return i < 0 ? (p.startsWith('/') ? '/' : '.') : path.slice(0, i).replace(/\/+$/u, '') || '/'
  }).join('\n') + '\n')
}

export const NAV_COMMANDS = {
  pwd, cd, ls, find, tree, basename: basenameCmd, dirname: dirnameCmd, ...FS_TOOLS,
}
