// The shell's working directory: `cd`, which moves it as bash's builtin does,
// and `pwd`, which names it.

import { resolve } from '../fs.js'
import { homeOf } from '../shell/expand.js'
import { parseArgs } from '../args.js'
import { err, ok } from '../util.js'
import { shellMessage, unsupported } from '../unsupported.js'
import { lookupWithNote } from '../notes.js'
import { printableName } from '../shell/printable.js'

// The working directory as bash names it, which a `cd //` began with two
// slashes: POSIX leaves a leading `//` to the system, and bash keeps it.
const logicalCwd = (ctx) => (ctx.doubleSlash ? '/' : '') + ctx.cwd

export function pwd(_stdin, tokens, ctx) {
  parseArgs(tokens)
  return ok(logicalCwd(ctx) + '\n')
}

// A successful cd updates PWD and OLDPWD; cd - also prints the destination.
export function cd(_stdin, tokens, ctx) {
  const { positional } = parseArgs(tokens)
  if (positional.length > 1) return err(shellMessage('cd: too many arguments'))
  if (!positional.length && ctx.vars.unsetNames.has('HOME')) return err(shellMessage('cd: HOME not set'))
  let target = positional[0] ?? homeOf(ctx)
  if (target === '-') {
    if (!ctx.vars.has('OLDPWD')) return err(shellMessage('cd: OLDPWD not set'))
    target = ctx.vars.get('OLDPWD')
  }
  const printed = positional[0] === '-' ? target + '\n' : ''
  if (target === '') return ok(printed)
  const { path: abs, error } = lookupWithNote(ctx, 'cd', target)
  if (error) return err(shellMessage(`cd: ${printableName(target)}: ${error}`))
  if (!ctx.fs.isDir(abs)) return err(shellMessage(`cd: ${printableName(target)}: Not a directory`))
  // Bash keeps the name it was given in PWD, links and all, and collapses a
  // later `..` in it rather than in the path it leads to — the logical
  // directory `cd -L` means and `pwd` prints. Nothing here holds a working
  // directory that is not the one on the filesystem, so a path that crosses a
  // link is refused rather than answered as `cd -P` would answer it. A walk
  // that crossed none leaves the same path lexical normalization does.
  if (abs !== resolve(ctx.cwd, target)) {
    return unsupported('feature', 'cd', 'symbolic link cwd', `cd: ${target}: a working directory reached through a symbolic link is not supported (it leads to ${abs})`)
  }
  // A path naming exactly two slashes first keeps them, and a relative one
  // keeps whatever the directory it starts from had.
  const doubleSlash = target.startsWith('/') ? /^\/\/(?!\/)/u.test(target) : Boolean(ctx.doubleSlash)
  ctx.vars.set('OLDPWD', logicalCwd(ctx))
  ctx.cwd = abs
  ctx.doubleSlash = doubleSlash
  ctx.vars.set('PWD', logicalCwd(ctx))
  return ok(printed)
}
