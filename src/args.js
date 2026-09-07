// Split a command's tokens into { flags, values, positional } against
// a strict schema. Each command declares the option names it
// understands; any other `-x` / `--xyz` token throws — silent
// acceptance would let typos like `head -X 5` look like they did
// nothing. `--` ends flag processing; subsequent tokens are
// positional. A bare `-` is also positional; negative numbers need
// the explicit numericOperands schema setting (used by seq).
//
// Schema fields (each accepts an iterable of names; defaults empty):
//   short      — boolean short flags (e.g. `i` for `-i`)
//   long       — boolean long flags (e.g. `verbose` for `--verbose`)
//   valueShort — short flags that consume the next token as value
//                (e.g. `n` for `head -n 5`); inline `-n5` also works
//   valueLong  — long flags that consume the next token as value
//                (e.g. `name` for `find --name foo`). The GNU
//                `--name=value` form is also accepted (the inline
//                value wins and the next token is left untouched).
//   repeatable — value flags (short or long) that may appear more than
//                once; their values collect into an ARRAY in `values`
//                (e.g. `e` for `grep -e a -e b` → `['a', 'b']`) instead
//                of the last-wins scalar a plain value flag stores.
//   stopAtFirstPositional — when true, stop parsing flags as soon
//                as a non-flag positional appears; the rest of the
//                tokens are pushed as positional verbatim. Used by
//                xargs so flags meant for the inner command (e.g.
//                `xargs grep -n PATTERN`) aren't eaten by xargs.
//   numericOperands — when true, undeclared -DIGIT tokens are operands.
//
// Bundled short flags split across chars (`-an` → `-a` + `-n`); a
// value-taking short inside a bundle takes the rest of the bundle
// as its value (`-n5`).
//
// The result also carries `order`: every option — short or long
// — in the sequence it appeared, as `[{ name, value? }]`. grep uses it
// to resolve `--include` / `--exclude` by GNU's last-match-wins rule
// and head to resolve `-n` / `-c` the same way; neither is expressible
// through the per-name `values` map, which loses order across names.

import { UnsupportedError } from './unsupported.js'

export function parseArgs(tokens, schema = {}) {
  const short = asSet(schema.short)
  const long = asSet(schema.long)
  const valueShort = asSet(schema.valueShort)
  const valueLong = asSet(schema.valueLong)
  const repeatable = asSet(schema.repeatable)
  const stopEarly = schema.stopAtFirstPositional ?? false
  const flags = new Set()
  const values = new Map()
  const positional = []
  const order = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    // `--` ends flag processing here, not at the top of the function:
    // a value-taking option (`--name`, `-n`) that immediately precedes
    // `--` consumes it as the value via `takeNext`, so the terminator
    // check has to run AFTER any value-consumption opportunity. POSIX
    // getopt behavior — pre-splitting the token list breaks it.
    if (t === '--') { positional.push(...tokens.slice(i + 1)); break }
    if (t === '-') {
      if (stopEarly) { positional.push(...tokens.slice(i)); break }
      positional.push(t); continue
    }
    if (t.startsWith('--') && t.length > 2) {
      // GNU long options accept both `--name value` and `--name=value`.
      // Split on the first `=`: everything after it is the inline value,
      // so the next token is left alone. `??` (not `||`) picks the next
      // token only when there is no `=` at all, so `--name=` passes an
      // empty string rather than swallowing the following token. A
      // boolean long handed an inline value (`--verbose=x`) is a user
      // error, surfaced as such instead of silently ignored.
      const eq = t.indexOf('=')
      const name = eq === -1 ? t.slice(2) : t.slice(2, eq)
      const inlineVal = eq === -1 ? null : t.slice(eq + 1)
      if (valueLong.has(name) || repeatable.has(name)) {
        const value = inlineVal ?? takeNext(tokens, ++i, `--${name}`)
        addValue(values, repeatable, name, value)
        order.push({ name, value })
      } else if (long.has(name)) {
        if (inlineVal !== null) throw new Error(`option --${name} doesn't allow an argument`)
        flags.add(name)
        order.push({ name })
      } else throw new UnsupportedError('option', `--${name}`, `unknown option: --${name}`)
      continue
    }
    if (t.startsWith('-') && t.length > 1 && !(schema.numericOperands && isNumericPositional(t, short, valueShort, repeatable))) {
      i = consumeShorts(tokens, i, short, valueShort, repeatable, flags, values, order)
      continue
    }
    if (stopEarly) { positional.push(...tokens.slice(i)); break }
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

function takeNext(tokens, i, label) {
  if (i >= tokens.length) throw new Error(`${label} requires an argument`)
  return tokens[i]
}

// Store a value flag's argument. Repeatable flags accumulate into an
// array (`-e a -e b` → `['a', 'b']`); the rest keep the last value.
function addValue(values, repeatable, name, val) {
  if (!repeatable.has(name)) { values.set(name, val); return }
  const prev = values.get(name)
  if (prev) prev.push(val)
  else values.set(name, [val])
}

function consumeShorts(tokens, i, short, valueShort, repeatable, flags, values, order) {
  const chars = tokens[i].slice(1)
  for (let j = 0; j < chars.length; j++) {
    const c = chars[j]
    if (valueShort.has(c) || repeatable.has(c)) {
      // Inline value (`-n5`) wins over the next token; `++i` only runs
      // in the else branch, so a bundle that carried its own value
      // leaves the token index where it was.
      const value = j + 1 < chars.length ? chars.slice(j + 1) : takeNext(tokens, ++i, `-${c}`)
      addValue(values, repeatable, c, value)
      order.push({ name: c, value })
      return i
    }
    if (!short.has(c)) throw new UnsupportedError('option', `-${c}`, `unknown option: -${c}`)
    flags.add(c)
    order.push({ name: c })
  }
  return i
}
