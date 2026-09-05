// Bash-style brace expansion. Runs once per pipeline stage (and once
// per `for` word list), BEFORE variable substitution and `expandGlobs`
// — so `{foo,bar}*.js` first becomes `foo*.js bar*.js` and then each
// piece globs against the FS, and a value bound to `$f` is never read
// as brace syntax. The result's `origin[j]` is the input index output
// word `j` came from, so the substitution pass can find the
// tokenizer's record for a word this pass multiplied.
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
  if (argv.length === 0) return { argv: [], quoted: new Set(), origin: [] }
  const out = [argv[0]]
  const origin = [0]
  const newQuoted = new Set()
  if (quotedSet.has(0)) newQuoted.add(0)
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]
    if (quotedSet.has(i)) {
      newQuoted.add(out.length)
      out.push(tok)
      origin.push(i)
      continue
    }
    for (const e of expandOne(tok)) {
      out.push(e)
      origin.push(i)
    }
  }
  return { argv: out, quoted: newQuoted, origin }
}

// Find the leftmost balanced `{...}` with at least one top-level
// comma. Split on that comma, recombine each alternative with the
// surrounding prefix/suffix, and recurse so adjacent and nested
// groups expand naturally. No comma → no expansion (matches bash).
// The braces are paired in one pass up front (`pairBraces`), so a `{`
// with no partner costs nothing to skip — scanning forward from each
// `{` in turn made a word of N unmatched braces cost N passes over it.
function expandOne(token) {
  const { close, comma } = pairBraces(token)
  for (let i = 0; i < token.length; i++) {
    if (token[i] !== '{') continue
    const end = close.get(i)
    if (end === undefined || !comma.has(i)) continue
    const parts = splitTopCommas(token.slice(i + 1, end))
    const prefix = token.slice(0, i)
    const suffix = token.slice(end + 1)
    const out = []
    for (const part of parts) out.push(...expandOne(prefix + part + suffix))
    return out
  }
  return [token]
}

// One pass over the word: `close` maps each matched `{` to its `}`, and
// `comma` holds every `{` (matched or not) with a comma at its own
// nesting level — the two facts the old forward scan re-derived for
// each `{`. A `}` with nothing open is ordinary text, as before, and
// so is a `{` still open at the end: it never appears in `close`.
function pairBraces(s) {
  const open = []
  const close = new Map()
  const comma = new Set()
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '{') open.push(i)
    else if (c === '}') { if (open.length > 0) close.set(open.pop(), i) }
    else if (c === ',' && open.length > 0) comma.add(open.at(-1))
  }
  return { close, comma }
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
