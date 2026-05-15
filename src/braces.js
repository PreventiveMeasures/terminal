// Bash-style brace expansion. Runs once per pipeline stage, BEFORE
// `expandGlobs` — so `{foo,bar}*.js` first becomes `foo*.js bar*.js`
// and then each piece globs against the FS.
//
// Rules (matching bash, narrower scope):
//   `{a,b,c}`            → 3 argv items
//   `pre{a,b}post`       → `preapost`, `prebpost`
//   `{a,b}{c,d}`         → cartesian: `ac`, `ad`, `bc`, `bd`
//   `{a,b{c,d}}`         → nested: `a`, `bc`, `bd`
//   `{a}`, `{}`, `{abc`  → unchanged (no comma, no expansion)
//   `"{a,b}"`            → unchanged (quoted token)
//   `{,a,}`              → 3 items including two empties (bash compat)
//
// What's NOT supported (intentional):
//   `{1..5}`             → ranges. Adds another grammar.
//   Brace expansion inside `argv[0]` (the command name) — same
//   carve-out `expandGlobs` already takes; expanding a command name
//   into multiple tokens is rare and surprising.

export function expandBraces(argv, quotedSet) {
  if (argv.length === 0) return { argv: [], quoted: new Set() }
  const out = [argv[0]]
  const newQuoted = new Set()
  if (quotedSet.has(0)) newQuoted.add(0)
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]
    if (quotedSet.has(i)) {
      newQuoted.add(out.length)
      out.push(tok)
      continue
    }
    for (const e of expandOne(tok)) out.push(e)
  }
  return { argv: out, quoted: newQuoted }
}

// Find the leftmost balanced `{...}` with at least one top-level
// comma. Split on that comma, recombine each alternative with the
// surrounding prefix/suffix, and recurse so adjacent and nested
// groups expand naturally. No comma → no expansion (matches bash).
function expandOne(token) {
  for (let i = 0; i < token.length; i++) {
    if (token[i] !== '{') continue
    const close = matchBrace(token, i)
    if (close === -1) continue
    const parts = splitTopCommas(token.slice(i + 1, close))
    if (parts.length < 2) continue
    const prefix = token.slice(0, i)
    const suffix = token.slice(close + 1)
    const out = []
    for (const part of parts) out.push(...expandOne(prefix + part + suffix))
    return out
  }
  return [token]
}

function matchBrace(s, start) {
  let depth = 1
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function splitTopCommas(s) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') depth--
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts
}
