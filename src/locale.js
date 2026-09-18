// The locale this terminal runs in: C.UTF-8, glibc's own, where text is read
// a character at a time, collation is code point order and the decimal point
// is `.`. It is the one locale implemented, so it is the one a session can be
// in: the variables that pick the character set — LANG, LC_ALL and LC_CTYPE —
// take a spelling of C.UTF-8 and nothing else, and `createTerminal` takes the
// same. The other LC_ categories read the same in C and POSIX as they do here,
// so those keep taking both.
//
// A command that would read text differently elsewhere asks here rather than
// the variables, so a locale this terminal cannot run in is refused where it
// would first change an answer, never answered as if it were this one.

import { UnsupportedError } from './unsupported.js'

export const LOCALE = 'C.UTF-8'
export const ONLY_C_UTF8 = 'only the C.UTF-8 locale is supported'

// glibc takes the codeset spelt with or without the hyphen, in either case.
export const spellsCUtf8 = (value) => typeof value === 'string' && /^C\.UTF-?8$/iu.test(value)

const CTYPE_VARIABLES = new Set(['LANG', 'LC_ALL', 'LC_CTYPE'])

export function localeOption(opts) {
  if (opts.locale === undefined || spellsCUtf8(opts.locale)) return LOCALE
  throw new TypeError(`createTerminal: ${ONLY_C_UTF8} (got ${JSON.stringify(opts.locale)})`)
}

// A shell assignment to a locale variable is refused unless it leaves the
// character set where it is. An empty LC_ALL or LC_CTYPE hands the choice
// back to LANG, which is fine; an empty LANG would hand it to the C locale.
export function checkLocaleAssignment(name, value) {
  const accepted = CTYPE_VARIABLES.has(name)
    ? spellsCUtf8(value) || (name !== 'LANG' && value === '')
    : spellsCUtf8(value) || value === 'C' || value === 'POSIX' || value === ''
  if (!accepted) throw new UnsupportedError('feature', name, `${name}: ${ONLY_C_UTF8}`)
}

// Where a command reads bytes rather than characters for the C and POSIX
// locales, this is what it asks. No session can be in either today, so the
// answer is false; the branches it selects are what a settable locale would
// switch on, and they are kept for that day rather than torn out.
export const isByteLocale = (locale) => locale === 'C' || locale === 'POSIX'
export const byteLocale = (ctx) => isByteLocale(ctx.locale)
