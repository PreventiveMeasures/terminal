// Strict getopt-style parsing: undeclared options produce diagnostics.
// Schema iterables: short/long contain boolean flags; valueShort/valueLong
// take arguments; repeatable collects argument arrays instead of last values.
// Short options may be bundled, and values may be attached (-n5, --name=x).
// stopAtFirstPositional leaves the remaining tokens untouched for commands
// such as xargs. numericOperands permits undeclared negative-number operands.
// The order array preserves cross-option precedence that values alone loses.
// An option short of its value, or a flag handed one, is an OptionError,
// which the command answers in its own tool's words (optionFailure below).

import { err } from './result.js'
import { UnsupportedError, unsupported } from './unsupported.js'

export function parseArgs(tokens, schema = {}) {
  const short = asSet(schema.short)
  const long = asSet(schema.long)
  const valueShort = asSet(schema.valueShort)
  const valueLong = asSet(schema.valueLong)
  const repeatable = asSet(schema.repeatable)
  const flags = new Set()
  const values = new Map()
  const positional = []
  const order = []
  let i = 0

  // Both spellings share validation, argument consumption and recording.
  // Returning true ends a short bundle whose remainder became its value.
  function consumeOption(name, inline, isLong = false) {
    const label = (isLong ? '--' : '-') + name
    const takesValue = (isLong ? valueLong : valueShort).has(name) || (repeatable.has(name) && (!isLong || name.length > 1))
    if (takesValue) {
      const value = inline ?? tokens[++i]
      if (inline === null && i >= tokens.length) throw new OptionError(label, true)
      if (repeatable.has(name)) {
        const previous = values.get(name)
        if (previous) previous.push(value)
        else values.set(name, [value])
      } else values.set(name, value)
      order.push({ name, value })
    } else {
      if (!(isLong ? long : short).has(name)) throw new UnsupportedError('option', label, 'unknown option: ' + label)
      if (isLong && inline !== null) throw new OptionError(label, false)
      flags.add(name)
      order.push({ name })
    }
    return takesValue
  }

  for (; i < tokens.length; i++) {
    const t = tokens[i]
    // A preceding value option can consume '--'; do not pre-split tokens.
    if (t === '--') { positional.push(...tokens.slice(i + 1)); break }
    if (t.startsWith('--') && t.length > 2) {
      // Distinguish no '=' from an explicitly empty value (--name=).
      const eq = t.indexOf('=')
      consumeOption(eq === -1 ? t.slice(2) : t.slice(2, eq), eq === -1 ? null : t.slice(eq + 1), true)
      continue
    }
    if (t.startsWith('-') && t.length > 1 && !(schema.numericOperands && isNumericPositional(t, short, valueShort, repeatable))) {
      for (let j = 1; j < t.length; j++) {
        if (consumeOption(t[j], j + 1 < t.length ? t.slice(j + 1) : null)) break
      }
      continue
    }
    if (schema.stopAtFirstPositional) { positional.push(...tokens.slice(i)); break }
    positional.push(t)
  }
  return { flags, values, positional, order }
}

// Commands opting into numeric operands still give declared digit flags
// precedence. Everywhere else digit options go through normal validation;
// treating `grep -2` as a pattern or `cat -2` as a file corrupts results.
function isNumericPositional(token, short, valueShort, repeatable) {
  if (!/^-\d/u.test(token)) return false
  const c = token[1]
  return !short.has(c) && !valueShort.has(c) && !repeatable.has(c)
}

function asSet(v) {
  if (v instanceof Set) return v
  return new Set(v ?? [])
}

// glibc getopt's own words for a command line it could not finish reading,
// which every tool built on it prints after the name it was run by: an
// option with nothing left to take as its value, or a long flag handed one
// with `=`. What follows that line is the tool's own business.
export class OptionError extends Error {
  constructor(label, missing) {
    const requires = label.startsWith('--') ? `option '${label}' requires an argument` : `option requires an argument -- '${label.slice(1)}'`
    super(missing ? requires : `option '${label}' doesn't allow an argument`)
    this.name = 'OptionError'
    this.option = label
    this.missing = missing
  }
}

const tryHelp = (name) => `Try '${name} --help' for more information.`
const shortMissing = (e) => e.missing && !e.option.startsWith('--')

// coreutils follows getopt's line with one pointing at --help, both naming
// the program by what it was run as, and exits 1 — sort and ls exit 2, as
// they do for every usage error. The tools that part ways from that are
// named here, recorded from grep 3.11, gzip 1.12, curl 8.5, perl's shasum
// and tree 2.1.1; gawk, sed and xxd go on to print their whole usage text,
// which this does not carry, so they refuse, as the others do where what
// they say is not recorded. gzip's front ends are scripts that run gzip
// itself, which is the name they all answer by.
const gzipFailure = (name, e) => err(`${name}: ${e.message}\nTry \`gzip --help' for more information.`)
const OPTION_FAILURES = {
  __proto__: null,
  sort: (name, e) => err(`${name}: ${e.message}\n${tryHelp(name)}`, 2),
  ls: (name, e) => err(`${name}: ${e.message}\n${tryHelp(name)}`, 2),
  grep: (name, e) => err(`${name}: ${e.message}\nUsage: ${name} [OPTION]... PATTERNS [FILE]...\n${tryHelp(name)}`, 2),
  gzip: gzipFailure,
  gunzip: (_, e) => gzipFailure('gzip', e),
  zcat: (_, e) => gzipFailure('gzip', e),
  gzcat: (_, e) => gzipFailure('gzip', e),
  curl: (_, e) => (e.missing ? err(`curl: option ${e.option}: requires parameter\ncurl: try 'curl --help' or 'curl --manual' for more information`, 2) : null),
  shasum: (_, e) => (shortMissing(e) ? err(`Option ${e.option.slice(1)} requires an argument\nType shasum -h for help`) : null),
  tree: (_, e) => (shortMissing(e) ? err(`tree: Missing argument to ${e.option} option.`) : null),
  awk: () => null,
  sed: () => null,
  xxd: () => null,
}

// What `cmd`, run as `name`, says of an OptionError.
export function optionFailure(name, e, cmd = name) {
  const answer = OPTION_FAILURES[cmd]
  const result = answer === undefined ? err(`${name}: ${e.message}\n${tryHelp(name)}`) : answer(name, e)
  return result ?? unsupported('option', cmd, e.option, `${name}: ${e.message} (what ${cmd} says after this is not supported)`)
}
