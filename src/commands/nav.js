// Commands that navigate or query the virtual filesystem.

import { compareNames, resolve } from '../fs.js'
import { unsupported } from '../unsupported.js'
import { tree } from './tree.js'
import { find } from './find.js'
import { homeOf } from '../shell/expand.js'
import { parseArgs } from '../args.js'
import { err, ok, usage } from '../util.js'
import { hiddenEntryNotes, lookupWithNote } from '../notes.js'

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
  ctx.vars.set('OLDPWD', ctx.cwd)
  ctx.vars.set('PWD', abs)
  ctx.cwd = abs
  return ok(printed)
}

// Non-TTY ls: one name per line, lexical order, classification only
// with -F. Metadata cannot be fabricated by a path-to-content filesystem.
function ls(_stdin, tokens, ctx) {
  const { flags, positional } = parseArgs(tokens, { short: ['1', 'l', 'a', 'A', 'R', 'd', 'r', 'F'] })
  if (flags.has('l')) return unsupported('feature', 'ls', '-l metadata', 'ls: long listings require permissions, ownership and timestamps absent from this virtual filesystem')
  const targets = (positional.length ? positional : ['.']).toSorted(compareNames)
  if (flags.has('r')) targets.reverse()
  const dirs = [], errors = [], files = []
  const hidden = hiddenEntryNotes()
  const display = (name, abs) => flags.has('F') && ctx.fs.isDir(abs) && !name.endsWith('/') ? name + '/' : name
  for (const target of targets) {
    const { path: abs, error } = lookupWithNote(ctx, 'ls', target)
    if (error) errors.push(`ls: ${target}: ${error.toLowerCase()}`)
    else if (flags.has('d') || ctx.fs.isFile(abs)) files.push(display(target, abs))
    else dirs.push(target)
  }
  const blocks = files.length ? [files.join('\n')] : []
  for (const target of dirs) {
    const stack = [target]
    while (stack.length) {
      const path = stack.pop()
      const abs = resolve(ctx.cwd, path)
      const entries = ctx.fs.listDir(abs)
      if (!flags.has('a') && !flags.has('A')) hidden.collect(abs, entries)
      const names = [...entries.dirs, ...entries.files].filter((n) => flags.has('a') || flags.has('A') || !n.startsWith('.'))
      if (flags.has('a')) names.push('.', '..')
      names.sort(compareNames)
      if (flags.has('r')) names.reverse()
      const rows = names.map((n) => display(n, resolve(abs, n)))
      if (targets.length > 1 || flags.has('R')) rows.unshift(path + ':')
      if (rows.length) blocks.push(rows.join('\n'))
      if (!flags.has('R')) continue
      for (const name of names.toReversed()) {
        if (name === '.' || name === '..' || !ctx.fs.isDir(resolve(abs, name))) continue
        stack.push(path.endsWith('/') ? path + name : path + '/' + name)
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
  pwd, cd, ls, find, tree, basename: basenameCmd, dirname: dirnameCmd,
}
