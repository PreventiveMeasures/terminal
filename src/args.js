// Strict getopt-style parsing: undeclared options produce diagnostics.
// Schema iterables: short/long contain boolean flags; valueShort/valueLong
// take arguments; repeatable collects argument arrays instead of last values.
// Short options may be bundled, and values may be attached (-n5, --name=x).
// stopAtFirstPositional leaves the remaining tokens untouched for commands
// such as xargs. numericOperands permits undeclared negative-number operands.
// The order array preserves cross-option precedence that values alone loses.

import { UnsupportedError } from './unsupported.js'

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
      if (inline === null && i >= tokens.length) throw new Error(label + ' requires an argument')
      if (repeatable.has(name)) {
        const previous = values.get(name)
        if (previous) previous.push(value)
        else values.set(name, [value])
      } else values.set(name, value)
      order.push({ name, value })
    } else {
      if (!(isLong ? long : short).has(name)) throw new UnsupportedError('option', label, 'unknown option: ' + label)
      if (isLong && inline !== null) throw new Error('option ' + label + " doesn't allow an argument")
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
