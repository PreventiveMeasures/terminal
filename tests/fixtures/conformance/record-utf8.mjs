// Records GNU grep 3.11's and GNU sed 4.9's answers over the `accents` tree
// in the C.UTF-8 locale, for utf8.tests. Run once, with both installed and a
// glibc that ships C.UTF-8; the corpus it writes is replayed without them.
// Refusals are not recorded: they are this implementation's, written by hand
// at the end of the corpus.
//
//   node tests/fixtures/conformance/record-utf8.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { env, stdout } from 'node:process'
import { URL } from 'node:url'
import { TREES } from './trees.js'

const COMMANDS = [
  // A letter stands for its case-folded set: the upper case, the lower case
  // of that, and the lonesome letters that map up to the same upper case.
  'grep -i é one', 'grep -i É one', 'grep -ic café cafe', 'grep -i CAFÉ cafe', 'grep -iF café cafe', 'grep -ix café cafe',
  'grep -iw café cafe', 'grep -io É cafe', 'grep -in caf. cafe', "grep -i '[é]' cafe", "grep -ic '[^é]' cafe", 'grep -iv café cafe',
  'grep -i σ sigma', 'grep -i ς sigma', 'grep -i Σ sigma', "grep -i '[σ]' sigma", 'grep -io σ sigma', 'grep -ic Σ sigma',
  'grep -i i si', 'grep -i I si', 'grep -i ı si', 'grep -i İ si', 'grep -i s si', 'grep -i ſ si', 'grep -i k si', 'grep -i K si', 'grep -i K si',
  'grep -iF ı si', "grep -i '[i]' si", "grep -ic '[^i]' si", "grep -i '[a-z]' si", "grep -i '[[:lower:]]' si", "grep -i '[[:upper:]]' si",
  'grep -i ǅ dz', 'grep -i ǆ dz', 'grep -i Ǆ dz', 'grep -i ι iota', 'grep -i Ι iota', 'grep -ic ͅ iota', 'grep -i ι iota',
  'grep -i µ micro', 'grep -i μ micro', 'grep -i Μ micro', "grep -i '[!-~]' micro", "grep -i '[!-~]' si",
  // Case-insensitive matching over text with no case at all, and over ASCII.
  "grep -i '[[:lower:]]' cjk", "grep '[[:lower:]]' cjk", "grep '[[:alpha:]]' cjk", 'grep -i 日本 cjk',
  'grep -i oak mixed', 'grep -ic OAK mixed', 'grep -io o.k mixed', 'grep -iw oak mixed', 'grep -ix Oak mixed', "grep -i '[[:upper:]]' mixed",
  "grep -i '[a-z]' mixed", "grep -icE '(o)ak' mixed", "grep -i '\\(o\\)\\1' mixed", "grep -in 'k$' mixed",
  // A range runs between its endpoints' upper cases, over the text's.
  "grep -i '[A-z]' misc", "grep '[A-z]' misc", "grep -i '[a-{]' misc", "grep '[a-{]' misc", "grep -i '[[-{]' misc", "grep '[[-{]' misc",
  "grep -i '[a-Z]' misc", "grep '[a-Z]' misc", "grep -i '[Z-a]' misc", "grep '[Z-a]' misc", "grep -i '[!-~]' misc",
  // A range or a collating element with a character past ASCII has no place
  // in C.UTF-8's collation.
  "grep '[à-ÿ]' one", "grep -i '[à-ÿ]' one", "grep '[[.é.]]' one", "grep '[[=é=]]' one",
  // Words are the alphanumerics and `_`, by the locale's tables.
  'grep -w é words', 'grep -wc foo words', 'grep -w cafe words', 'grep -w a dot', 'grep -w naïve words',
  "grep '\\bé' words", "grep 'é\\b' words", "grep -c '\\<é\\>' words", "grep -o '\\w*' one", "grep -o '\\w\\+' words", "grep -c '\\W' words",
  "grep -E '\\bfoo\\b' words", "grep -o 'ca\\B.' words", "grep -o '[[:alnum:]_]*' words", "grep -c '^[[:alpha:]]*$' words", "grep -on '[[:alpha:]]\\+' words",
  "grep -o '\\w' cjk", "grep -c '\\b' cjk", "grep -c '\\<' one", "grep -o '\\b.' dot",
  // Space is the locale's, which the em space is in and the no-break space is not.
  "grep -c '[[:space:]]' space", "grep -c '\\s' space", "grep -o 'a\\sb' space", "grep -c '[[:blank:]]' space", "grep -c 'a\\Sb' space",
  "grep -c '[[:punct:]]' words", "grep -o '[[:print:]]*' one", "grep -c '[[:graph:]]' space", "grep -c '[[:cntrl:]]' space",
  // The named classes and a non-ASCII literal beside a repetition.
  "grep -c '[[:alpha:]]' one", "grep -x '[[:alpha:]]' one", "grep -o '[[:alpha:]]' dot", "grep '^[[:alpha:]]$' one",
  "grep -cE 'é{2}' one", "grep -c 'é\\{1\\}' one", "grep -cE '(é|x)+' dot", "grep -c '[^é]' one", "grep -o '[^a-z]' cafe",
  "grep -c '[[:upper:]]' sigma", "grep -c '[[:lower:]]' sigma", "grep -c '[[:alpha:]]' iota", "grep -o '[[:digit:]]*' one",
  // The Cyrillic Extended-C letter, matched exactly.
  'grep в ve', 'grep -c ᲀ ve',
  // sed reads the same tables, with I for its case folding.
  "sed 's/é/X/I' cafe", "sed -n '/CAFÉ/Ip' cafe", "sed 's/[[:alpha:]]/x/' one", "sed 's/[[:alpha:]]/X/g' words", "sed 's/[[:lower:]]/X/Ig' cafe",
  "sed 's/[[:upper:]]/X/Ig' cafe", "sed 's/σ/X/Ig' sigma", "sed -n '/[[:upper:]]/p' sigma", "sed -n '/[[:upper:]]/Ip' cjk", "sed 's/\\w/X/g' dot",
  "sed 's/\\bé/X/' words", "sed 's/\\<caf\\>/X/' words", "sed -n '/[A-z]/Ip' misc", "sed -n '/[Z-a]/Ip' misc", "sed -n '/[a-Z]/Ip' misc",
  "sed 's/[à-ÿ]/X/' one", "sed 's/\\s/X/g' space", "sed 's/[[:space:]]/X/g' space", "sed 's/i/X/Ig' si", "sed 's/k/X/Ig' si",
  "sed -E 's/(é)/[\\1]/I' cafe", "sed 's/é/X/2I' words", "sed -n 's/[[:alpha:]]/X/2p' words", "sed -n '/[[:alpha:]]/p' cjk", "sed 's/./X/Ig' sigma",
  "sed -E 's/(a|ab)/[\\1]/I' mixed", "sed 's/oak/X/I' mixed", "sed -n '/OAK/I!p' mixed",
]

// What this implementation refuses, written by hand: PCRE reads case and
// classes by its own tables; a backreference under -i keeps the JS case
// flag, which agrees with GNU over ASCII alone; GNU's two matchers fold the
// Cyrillic Extended-C letters differently; a collating element, a
// backreference in sed and -o under -w are not modelled; and ripgrep matches
// Unicode by its own rules.
const REFUSALS = [
  'grep -Pi é one => ! non-ASCII regex semantics 2',
  "grep -P '\\w' one => ! non-ASCII regex semantics 2",
  "grep -i '\\(é\\)\\1' one => ! non-ASCII regex semantics 2",
  "grep -ic 'x\\(a\\)\\1' one => ! non-ASCII regex semantics 2",
  'grep -i в ve => ! locale-sensitive regex 2',
  'grep -i \u1C80 one => ! locale-sensitive regex 2',
  "sed 's/в/X/I' ve => ! case folding of Cyrillic Extended-C letters 1",
  "grep '[[.a.]]' one => ! regex collating or equivalence class 2",
  "grep '[[=a=]]' one => ! regex collating or equivalence class 2",
  "grep -wo 'caf.' words => ! -o regex extent 2",
  "sed 's/\\(o\\)\\1/X/I' mixed => ! regex backreferences 1",
  'rg . one => ! non-ASCII matching 2',
  'rg -i café cafe => ! non-ASCII matching 2',
]

// The `accents` tree, on disk, for the real tools to read.
function materialise(root) {
  for (const [path, content] of Object.entries(TREES.accents)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

function real(command, root) {
  const locale = { ...env, LC_ALL: 'C.UTF-8' }
  try {
    const out = execFileSync('bash', ['-c', `{ ${command} ; } 2>"${root}/.stderr"`], { cwd: root, encoding: 'utf8', env: locale, stdio: ['ignore', 'pipe', 'pipe'] })
    return { out, code: 0, err: readErr(root) }
  } catch (e) {
    return { out: e.stdout ?? '', code: e.status ?? -1, err: readErr(root) }
  }
}
const readErr = (root) => execFileSync('cat', [`${root}/.stderr`], { encoding: 'utf8' })

function line(command, r) {
  if (r.err && !r.out) return `${command} => % ${r.code}`
  const tail = [r.code ? String(r.code) : '', r.err ? '%' : ''].filter(Boolean).join(' ')
  return `${command} => ${JSON.stringify(r.out)}${tail ? ' ' + tail : ''}`
}

const root = mkdtempSync(join(tmpdir(), 'accents-'))
try {
  materialise(root)
  const versions = ['grep', 'sed'].map((tool) => execFileSync(tool, ['--version'], { encoding: 'utf8' }).split('\n')[0])
  const lines = [
    '# Text past ASCII in the C.UTF-8 locale, answered by GNU grep 3.11 and GNU',
    '# sed 4.9 in that locale and recorded by record-utf8.mjs: case folding, the',
    '# named classes, words and spaces, all read from glibc\'s own tables. The',
    '# refusals at the end are this implementation\'s and were written by hand.',
    `# Recorded from: ${versions.join('; ')}.`,
    '',
    '@tree accents',
    ...COMMANDS.map((command) => line(command, real(command, root))),
    '',
    ...REFUSALS,
  ]
  writeFileSync(new URL('./utf8.tests', import.meta.url), lines.join('\n') + '\n')
  stdout.write(`recorded ${COMMANDS.length} cases\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
