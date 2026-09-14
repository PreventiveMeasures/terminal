// The compound commands, which are a list in the end, and the two helpers
// that read what stands around one. Each takes from the grammar the one thing
// it needs of it: how to read a list.

import { NAME_RE } from './tokenize.js'
import { sliceWord } from './word.js'
import { tokenLabel } from './lex.js'
import { UnsupportedError } from '../unsupported.js'
import { IncompleteInput, incomplete, tokenAt } from './parse-input.js'

const BRANCH_ENDS = ['elif', 'else', 'fi']

export function parseConditional(p, buildSteps) {
  const branches = []
  let closer
  do {
    skipNewlines(p)
    const condition = buildSteps(p, 'then')
    skipNewlines(p)
    const body = buildSteps(p, BRANCH_ENDS)
    branches.push({ condition, body })
    closer = p.raw[p.i - 1].value
  } while (closer === 'elif')
  let otherwise = null
  if (closer === 'else') {
    skipNewlines(p)
    otherwise = buildSteps(p, 'fi')
  }
  return { branches, otherwise }
}
// Parse NAME in WORDS; do BODY; done. Headers skip exactly one separator;
// bodies allow newlines after do, but not semicolons. Implicit positional-
// parameter loops remain explicitly unsupported.
export function parseFor(p, buildSteps) {
  const { raw } = p
  const outer = p.loop
  p.loop = 'for'
  const nameTok = tokenAt(p)
  if (nameTok?.kind === 'paren_open') throw new UnsupportedError('feature', 'for ((', 'arithmetic `for ((…))` loops are not supported; use `for NAME in WORD...`')
  if (nameTok === undefined || nameTok.kind !== 'word') throw new Error('for: expected a variable name')
  const name = nameTok.value
  if (nameTok.quoted || !NAME_RE.test(name)) throw new Error(`for: \`${name}\` is not a valid variable name`)
  p.i++
  const separator = tokenAt(p)
  if (separator?.kind === 'semi') p.i++
  const inToken = tokenAt(p)
  if (separator?.kind === 'semi' && !separator.newline && isWord(inToken, 'in')) throw new Error('for: unexpected `in` after `;`')
  if (!isWord(inToken, 'in')) {
    if (isWord(inToken, 'do') || inToken === undefined) {
      const gap = new UnsupportedError('feature', 'for NAME; do', `\`for ${name}; do …\` iterates the positional parameters, which this shell does not have; write \`for ${name} in WORD...\``)
      throw inToken === undefined ? new IncompleteInput(gap) : gap
    }
    throw new Error(`for: expected \`in\` after \`${name}\``)
  }
  p.i++
  const words = []
  // 'do' is a legal list item; remember it only for a missing-separator error.
  let sawDo = false
  for (let t; (t = tokenAt(p)) && t.kind !== 'semi'; p.i++) {
    if (t.kind !== 'word') throw new Error(`for: unexpected \`${tokenLabel(t)}\` in word list`)
    if (isWord(t, 'do')) sawDo = true
    words.push(sliceWord(t))
  }
  if (raw[p.i]?.kind === 'semi') p.i++
  const doToken = tokenAt(p)
  if (!isWord(doToken, 'do')) {
    if (doToken === undefined) throw incomplete(sawDo ? 'for: expected `;` or newline before `do`' : 'for: missing `do`')
    if (sawDo) throw new Error('for: expected `;` or newline before `do`')
    throw new Error(`for: expected \`do\`, got \`${tokenLabel(doToken)}\``)
  }
  p.i++
  skipNewlines(p)
  const loop = { name, words, body: buildSteps(p, 'done') }
  p.loop = outer
  return loop
}
// `while LIST; do LIST; done`, and `until`, which runs its body for as long
// as the condition fails instead. The keyword stays on the cursor for the
// diagnostics a missing `do` or `done` reports.
export function parseWhile(p, keyword, buildSteps) {
  const outer = p.loop
  p.loop = keyword
  skipNewlines(p)
  const condition = buildSteps(p, 'do')
  skipNewlines(p)
  const loop = { until: keyword === 'until', condition, body: buildSteps(p, 'done') }
  p.loop = outer
  return loop
}
// `name () { list; }`, whose body is a list like any other. Bash takes any
// compound command for a body; a brace group is the one this reads, since a
// `( … )` body would keep to itself what a caller asked it to do.
export function parseFunction(p, name, buildSteps) {
  if (name.quoted || !NAME_RE.test(name.value)) throw new UnsupportedError('feature', 'function', `shell functions named \`${name.value}\` are not supported`)
  p.i += 2
  skipNewlines(p)
  const open = tokenAt(p)
  if (!isWord(open, '{')) throw new UnsupportedError('feature', 'function', `\`${name.value}()\` needs a \`{ … }\` body`)
  p.i++
  skipNewlines(p)
  const body = buildSteps(p, '}')
  if (!macroSafe(body)) throw new UnsupportedError('feature', 'function', `\`${name.value}()\` is supported only while its body reads and writes no variable`)
  return { name: name.value, body }
}

// A body that is the same list wherever it is called: one that neither reads
// nor writes a variable, and so cannot tell a call from the line it stands in.
// What a caller would otherwise hand it — arguments as `$1`, a variable of its
// own, a `local` — is then nothing the body could have read.
const macroSafe = (steps) => steps.every((step) => step.stages.every(stageSafe))

function stageSafe(stage) {
  if (stage.assigns.length > 0 || stage.test || stage.define) return false
  if (stage.group) return macroSafe(stage.group)
  if (stage.conditional) return stage.conditional.branches.every((b) => macroSafe(b.condition) && macroSafe(b.body)) && macroSafe(stage.conditional.otherwise ?? [])
  if (stage.loop) return (stage.loop.words ?? []).every(plainWord) && macroSafe(stage.loop.condition ?? []) && macroSafe(stage.loop.body)
  return stage.words.every(plainWord) && stage.redirs.every((r) => r.word === undefined || plainWord(r.word))
}

// Text no expansion reads a name out of. Masks count UTF-16 units, so index
// the value the same way rather than by code point.
function plainWord(word) {
  for (let i = 0; i < word.value.length; i++) {
    const ch = word.value[i]
    if ((ch === '$' || ch === '`') && (word.mask === null || word.mask[i] !== '1')) return false
  }
  return true
}
// Block-opening keywords allow newlines before their lists, but not semicolons.
export function skipNewlines(p) {
  for (let t; (t = tokenAt(p))?.kind === 'semi' && t.newline;) p.i++
}

function isWord(t, value) {
  return t !== undefined && t.kind === 'word' && !t.quoted && t.value === value
}
