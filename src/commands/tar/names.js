// The names a tar command line gives, as GNU tar 1.35 reads them against an
// archive, and the two other ways it quotes a name in what it says.
//
// A member operand has its trailing slashes taken off (a lone `/` keeps its
// one) and then names what is stored under exactly that name, and whatever
// is stored below it: `repo/src` takes `repo/src/` and `repo/src/b.js`. It is
// no pattern — the wildcards are off unless asked for — so `*` is a star,
// and an operand spelled with one that matches nothing earns a warning that
// it may have been meant as a pattern. An empty operand names nothing and is
// never missed.

import { lookup } from '../../fs.js'
import { byteLocale } from '../../util.js'
import { quoteEscape } from './list.js'

// quotearg_colon: the escape style, with the colon escaped too, since the
// name stands before one in the message.
export const quoteColon = (text, ctx) => quoteEscape(text, ctx).replaceAll(':', '\\:')

// gnulib's quote(): the locale's own quotation marks, which in a UTF-8
// locale are the curly ones.
export function quoteLocale(text, ctx) {
  const inner = quoteEscape(text, ctx)
  return byteLocale(ctx) ? `'${inner.replaceAll("'", "\\'")}'` : `‘${inner}’`
}

export function memberOperand(name) {
  let end = name.length
  while (end > 1 && name[end - 1] === '/') end--
  return name.slice(0, end)
}

// fnmatch_pattern_has_wildcards, as GNU asks it of a name it did not find: a
// backslash takes the character after it out of the question.
function hasWildcards(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if ('?*[]'.includes(text[i])) return true
  }
  return false
}

// A stored name the operand names: itself, or anything under it.
const underOperand = (operand, stored) => stored === operand || (stored.startsWith(operand) && stored[operand.length] === '/')

// The operands of a list or an extraction, each with the `-C` directories
// that stood before it, and a way to ask which of them an entry is.
export function memberNames(items) {
  const names = []
  const dirs = []
  for (const item of items) {
    if (item.dir !== undefined) dirs.push(item.dir)
    else if (item.name !== '') names.push({ given: item.name, operand: memberOperand(item.name), dirs: [...dirs], found: false })
  }
  // With no operands every entry is taken, from wherever every `-C` leads.
  const everything = { dirs }
  return {
    names,
    match(stored) {
      if (names.length === 0) return everything
      const hit = names.find((name) => underOperand(name.operand, stored))
      if (hit !== undefined) hit.found = true
      return hit ?? null
    },
  }
}

// GNU's report of the operands nothing matched, once the archive is read.
export function reportMissing(names, state) {
  for (const name of names.names) {
    if (name.found) continue
    if (hasWildcards(name.operand)) {
      state.warn('Pattern matching characters used in file names')
      state.warn('Use --wildcards to enable pattern matching, or --no-wildcards to suppress this warning')
    }
    state.error(`${quoteColon(name.operand, state.ctx)}: Not found in archive`)
  }
}

// A `-C`, entered from where the one before it left off, as GNU enters it
// when an operand after it comes up; one it cannot enter ends the run.
export function enterDirectory(from, step, state) {
  const { ctx } = state
  const found = lookup(from, step, ctx.fs)
  const error = found.error ?? (ctx.fs.isDir(found.path) ? null : 'Not a directory')
  if (error === null) return found.path
  state.fatal(`${quoteColon(step, ctx)}: Cannot open: ${error}`)
  return null
}
