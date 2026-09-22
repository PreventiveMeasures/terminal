import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createFs } from '../src/fs.js'
import { classTables, isByteLocale } from '../src/locale.js'
import { tree } from '../src/commands/tree.js'
import { TEXT_COMMANDS } from '../src/commands/text.js'
import { EXTRA_COMMANDS } from '../src/commands/extra.js'
import { printf } from '../src/commands/printf.js'
import { unsupportedNote } from '../src/unsupported.js'
import { evaluateParameter } from '../src/shell/parameter.js'

// This terminal runs in C.UTF-8 and takes no other locale, so a byte locale is
// not one `createTerminal` can be put in. The branches that would answer for
// one are kept all the same (../src/locale.js), and these drive them where
// they live: a command is handed a context naming the locale, which is what it
// asks before it reads text a character at a time.
//
// Each pair below says what GNU says in that locale — recorded from coreutils
// 9.4, grep 3.11 and tree 2.1.1 over the same bytes — or says that this
// refuses to answer for it. What no pair says is one answer for both where the
// two tools differ: that is the silent UTF-8 these exist to catch.
const SOURCES = { 'u.txt': 'café\n', 'a.txt': 'abc\n', 'm.txt': 'café\nCAFÉ\nabc\nABC\n', 'd/x/f': '', 'd/y': '' }
const LOCALES = ['C.UTF-8', 'C']

// The shape a command reads a locale from. Built here rather than through
// `createTerminal`, which refuses every locale but the one.
const context = (locale) => ({
  fs: createFs(SOURCES), cwd: '/', locale, notes: [], vars: new Map(),
  createdAt: Date.UTC(2024, 0, 1), user: 'user', io: { read() {}, setReads() {} },
})

const COMMANDS = { ...TEXT_COMMANDS, ...EXTRA_COMMANDS, tree, printf }
const run = (name, args, locale) => COMMANDS[name]('', args, context(locale))
// What each locale answers, as the pair a command is judged by.
async function answers(name, args) {
  const out = {}
  for (const locale of LOCALES) {
    const r = await run(name, args, locale)
    out[locale] = unsupportedNote(r) ? { refused: r.stderr.trim() } : r.stdout
  }
  return out
}

describe('a byte locale is asked before text is read a character at a time', () => {
  it('is the switch every one of these turns on', () => {
    assert.deepEqual(['C', 'POSIX', 'C.UTF-8', 'en_US.UTF-8'].map(isByteLocale), [true, true, false, false])
    // The classes a byte locale names are ASCII's, and no more.
    assert.equal(classTables('C').body('alpha'), 'A-Za-z')
    assert.equal(classTables('C').multibyte, false)
    assert.ok(classTables('C.UTF-8').body('alpha').length > 'A-Za-z'.length)
    assert.equal(classTables('C.UTF-8').multibyte, true)
  })

  it('draws tree with the characters the locale has', async () => {
    const drawn = await answers('tree', ['d'])
    assert.equal(drawn['C.UTF-8'], 'd\n├── x\n│   └── f\n└── y\n\n2 directories, 2 files\n')
    assert.equal(drawn.C, 'd\n|-- x\n|   `-- f\n`-- y\n\n2 directories, 2 files\n')
  })

  it('counts a character or a byte as the locale has it', async () => {
    assert.deepEqual(await answers('wc', ['-m', 'u.txt']), { 'C.UTF-8': '5 u.txt\n', C: '6 u.txt\n' })
    // `-c` was always bytes, and no locale moves it.
    assert.deepEqual(await answers('wc', ['-c', 'u.txt']), { 'C.UTF-8': '6 u.txt\n', C: '6 u.txt\n' })
  })

  it('reads a class from the locale that names it', async () => {
    // Four letters in C.UTF-8, where é is one of them; three in C, where the
    // two bytes it is spelt in are letters in neither.
    assert.deepEqual(await answers('grep', ['-c', '[[:alpha:]]\\{4\\}', 'u.txt']), { 'C.UTF-8': '1\n', C: '0\n' })
    assert.deepEqual(await answers('grep', ['-c', '\\w\\{4\\}', 'u.txt']), { 'C.UTF-8': '1\n', C: '0\n' })
  })

  it('refuses a pattern it would otherwise read a character at a time', async () => {
    // A wildcard matches one character here and one byte there, and what é is
    // spelt in is two of them — so rather than answer as if the locale were
    // this one, it says it cannot.
    const wild = await answers('grep', ['-o', '.', 'u.txt'])
    assert.equal(wild['C.UTF-8'], 'c\na\nf\né\n')
    assert.equal(wild.C.refused, 'grep: matching non-ASCII text in the C locale is not supported')
    // A set spelt by what it excludes reaches past ASCII the same way.
    const excluded = await answers('grep', ['-c', '[^a]', 'u.txt'])
    assert.equal(excluded['C.UTF-8'], '1\n')
    assert.equal(excluded.C.refused, 'grep: matching non-ASCII text in the C locale is not supported')
    // Nothing is refused where the question does not arise: a literal reads
    // the same either way, and so does a wildcard over text that is ASCII.
    assert.deepEqual(await answers('grep', ['-c', 'caf', 'u.txt']), { 'C.UTF-8': '1\n', C: '1\n' })
    assert.deepEqual(await answers('grep', ['-o', '.', 'a.txt']), { 'C.UTF-8': 'a\nb\nc\n', C: 'a\nb\nc\n' })
  })

  it('answers the same in both where the tools do', async () => {
    // Recorded from the same tools under both locales: none of these reads a
    // character where the other reads a byte, so a pair that stopped matching
    // would be this terminal inventing a difference GNU does not have.
    for (const [name, args, expected] of [
      ['cut', ['-c1-3', 'u.txt'], 'caf\n'],
      ['nl', ['u.txt'], '     1\tcafé\n'],
      ['tac', ['u.txt'], 'café\n'],
      ['head', ['-n1', 'u.txt'], 'café\n'],
      ['sort', ['m.txt'], 'ABC\nCAFÉ\nabc\ncafé\n'],
      ['sort', ['-f', '-u', 'm.txt'], 'abc\nCAFÉ\ncafé\n'],
      ['uniq', ['-i', 'm.txt'], 'café\nCAFÉ\nabc\n'],
      ['base64', ['u.txt'], 'Y2Fmw6kK\n'],
      // coreutils pads and cuts `%s` by bytes wherever it runs.
      ['printf', ['%6s|', 'café'], ' café|'],
      ['printf', ['%-6s|', 'café'], 'café |'],
    ]) {
      assert.deepEqual(await answers(name, args), { 'C.UTF-8': expected, C: expected }, name + ' ' + args.join(' '))
    }
  })

  it('measures a parameter in what the locale counts in', async () => {
    // bash answers `${#x}` in bytes where a byte is a character, and in
    // characters where one is spelt in more than one. The first is exact here;
    // the second is refused, this counting in UTF-16 units rather than code
    // points, which parts company over anything astral.
    const length = async (locale) => {
      const options = { lookup: () => ({ value: 'café', set: true }), expand: (word) => ({ value: word }) }
      try { return (await evaluateParameter({ name: 'x', operator: 'length' }, { locale, vars: new Map() }, options)).value }
      catch (e) { return { refused: e.message } }
    }
    assert.equal(await length('C'), '5')
    assert.equal((await length('C.UTF-8')).refused, 'locale-dependent length of non-ASCII parameters is not supported: ${#x}')
  })

  it('refuses non-ASCII text outright where awk would have to read bytes', async () => {
    const { awk } = TEXT_COMMANDS
    const utf8 = await awk('', ['{print length}', 'u.txt'], context('C.UTF-8'))
    assert.equal(utf8.stdout, '4\n')
    const bytes = await awk('', ['{print length}', 'u.txt'], context('C'))
    assert.equal(bytes.stdout, '')
    assert.match(bytes.stderr, /non-ASCII AWK text in a byte locale is not supported/u)
  })
})
