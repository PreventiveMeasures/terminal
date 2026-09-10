import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { URL } from 'node:url'
import { createTerminal } from '@preventive/terminal'
import { AwkRegex } from '../src/awk/regex.js'

// Original Spencer vectors and permission notice are in fixtures/upstream/regex.
// This adapter follows the upstream main.c field/escape conventions, but uses
// only virtual commands and the shared JS regex implementation.
const FIXTURE = readFileSync(new URL('./fixtures/upstream/regex/spencer.tests', import.meta.url), 'utf8')
const decode = (s) => s?.replace(/[NSTZ]/gu, (c) => ({ N: '\n', S: ' ', T: '\t', Z: '\0' })[c])
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'"
const VECTORS = FIXTURE.split('\n').flatMap((line, index) => {
  if (!line || line.startsWith('#')) return []
  const [pattern, flags, input, match, captures] = line.split(/\t+/u).map((field) => field === '""' ? '' : field)
  return [{ line: index + 1, pattern, flags, input, match, captures }]
})

function exclusion(v) {
  if (v.flags.includes('C')) return 'compilation'
  if (/[n^$#p]/u.test(v.flags) || (v.pattern + v.input).includes('Z')) return 'libc execution flags/NUL termination'
  if (v.pattern === String.raw`a\bc` || v.pattern === 'a{,2}' || v.pattern === 'a{,}') return 'GNU dialect differs'
  if (v.pattern.includes('[:<:]') || v.pattern.includes('[:>:]') || v.pattern.includes('one')) return 'BSD class/collation names'
  return null
}

const PORTABLE = VECTORS.filter((v) => exclusion(v) === null)
const GREP_GAPS = new Map([
  ...[52, 53, 182, 183, 186, 244].map((line) => [line, 'GNU regex syntax']),
  ...[264, 270, 274, 297].map((line) => [line, 'regex collating or equivalence class']),
  [159, 'conditional backreference'],
])
// These subjects contain further nonoverlapping matches after the corpus's
// expected first extent: abc has three single-letter matches; the rest have two.
const REPEATED_MATCHES = new Map([[39, 3], ...[213, 214, 215, 216, 346, 358, 363, 364, 365, 366].map((line) => [line, 2])])

function expectedSpan(v) {
  if (v.match === undefined) return null
  const input = decode(v.input)
  if (v.match.startsWith('@')) {
    const start = v.match === '@' ? input.length : input.indexOf(decode(v.match.slice(1)))
    return { start, end: start }
  }
  const text = decode(v.match)
  const start = input.indexOf(text)
  assert.notEqual(start, -1, `invalid upstream match field at line ${v.line}`)
  return { start, end: start + text.length }
}

function result(stdout, exitCode = 0, notes = []) {
  return { stdout, stderr: '', exitCode, cwd: '/', notes, unsupported: [] }
}

function checkGap(actual, detail) {
  assert.equal(actual.stdout, '')
  assert.equal(actual.exitCode, 2)
  assert.equal(actual.unsupported.length, 1)
  assert.equal(actual.unsupported[0].detail, detail)
  assert.equal(actual.stderr, actual.unsupported[0].message + '\n')
}

it('pins the unmodified, permissively licensed 385-vector corpus', () => {
  assert.equal(VECTORS.length, 385)
  assert.equal(createHash('sha256').update(FIXTURE).digest('hex'), 'd03d4a61dd7bcd3637c70547f51d32f5713ad378fcc4578819bb332625e8f1bb')
  assert.equal(PORTABLE.length, 239)
  const counts = {}
  for (const v of VECTORS) {
    const reason = exclusion(v) ?? 'portable'
    counts[reason] = (counts[reason] ?? 0) + 1
  }
  assert.deepEqual(counts, {
    portable: 239, compilation: 100, 'libc execution flags/NUL termination': 29,
    'GNU dialect differs': 3, 'BSD class/collation names': 14,
  })
})

describe('Spencer portable vectors through GNU grep syntax', () => {
  for (const v of PORTABLE) {
    const input = decode(v.input), pattern = decode(v.pattern)
    // grep operates on separate lines, unlike regexec's complete subject.
    if (pattern.includes('\n') || input.includes('\n')) continue
    const modes = v.flags.includes('&') ? ['', 'E'] : [v.flags.includes('b') ? '' : v.flags.includes('m') ? 'F' : 'E']
    for (const mode of modes) {
      it(`line ${v.line}, ${mode || 'BRE'}: ${v.pattern}`, () => {
        const terminal = createTerminal({ input: input + '\n' })
        const command = `grep -a${mode}${v.flags.includes('i') ? 'i' : ''} -e ${quote(pattern)} input`
        const gap = GREP_GAPS.get(v.line)
        const applies = gap && (mode === 'E' || gap !== 'GNU regex syntax')
        if (applies) { checkGap(terminal.run(command), gap); return }
        const span = expectedSpan(v)
        assert.deepEqual(terminal.run(command), result(span ? input + '\n' : '', span ? 0 : 1))
        if (!span || span.start === span.end || /\\[1-9]/u.test(pattern)) return
        // First nonempty extent isolates the upstream oracle even when grep -o
        // emits additional nonoverlapping matches from the same selected line.
        const only = terminal.run(command.replace('grep ', 'grep -o ') + ' | head -1')
        const total = REPEATED_MATCHES.get(v.line)
        const notes = total ? [`head: selected 1 of ${total} lines from standard input.`] : []
        assert.deepEqual(only, result(input.slice(span.start, span.end) + '\n', 0, notes))
      })
    }
  }
})

describe('Spencer ERE vectors through AWK match and boolean matching', () => {
  for (const v of PORTABLE.filter((entry) => !/[bm]/u.test(entry.flags))) {
    it(`line ${v.line}: ${v.pattern}`, () => {
      const input = decode(v.input), pattern = decode(v.pattern), span = expectedSpan(v)
      const program = `BEGIN { IGNORECASE=${v.flags.includes('i') ? 1 : 0}; s=${JSON.stringify(input)}; r=${JSON.stringify(pattern)}; print (s ~ r), match(s,r), RLENGTH }`
      const stdout = span ? `1 ${span.start + 1} ${span.end - span.start}\n` : '0 0 -1\n'
      assert.deepEqual(createTerminal({}).run('awk ' + quote(program)), result(stdout))
    })
  }
})

describe('Spencer captures preserve their extent or diagnose unsupported ties', () => {
  for (const v of PORTABLE.filter((entry) => entry.captures && !/[bm]/u.test(entry.flags))) {
    it(`line ${v.line}: ${v.pattern}`, () => {
      const input = decode(v.input), span = expectedSpan(v)
      const re = new AwkRegex(decode(v.pattern), v.flags.includes('i'))
      if (re.captureShape.unsafe) {
        assert.throws(() => re.groups(input, span.start, span.end), (error) => error.gap === 'regex capture semantics')
        const program = `BEGIN { print gensub(${JSON.stringify(decode(v.pattern))}, ${JSON.stringify('\\1')}, 1, ${JSON.stringify(input)}) }`
        checkGap(createTerminal({}).run('awk ' + quote(program)), 'regex capture semantics')
        return
      }
      const found = re.groups(input, span.start, span.end)
      for (const [index, capture] of v.captures.split(',').entries()) {
        const group = found[index + 1]
        if (capture === '-') assert.equal(group, undefined)
        else if (capture.startsWith('@')) {
          assert.equal(group.text, '')
          const suffix = decode(capture.slice(1))
          if (suffix) assert.ok(input.slice(group.start).startsWith(suffix))
          else assert.equal(group.start, input.length)
        } else assert.equal(group.text, decode(capture))
      }
    })
  }
})

// BSD error classifications differ for intervals, empty branches and stacked
// repetitions. These errors have the same validity rules in GNU grep.
const SHARED_ERRORS = new Set(['EPAREN', 'EESCAPE', 'ESUBREG', 'EBRACK', 'ERANGE', 'ECTYPE'])
describe('Spencer compilation errors shared with GNU grep', () => {
  for (const v of VECTORS.filter((entry) => entry.flags.includes('C') && SHARED_ERRORS.has(entry.input))) {
    const modes = v.flags.includes('&') ? ['', 'E'] : [v.flags.includes('b') ? '' : 'E']
    for (const mode of modes) {
      it(`line ${v.line}, ${mode || 'BRE'}: ${v.pattern}`, () => {
        const actual = createTerminal({ input: 'abc\n' }).run(`grep -a${mode} -e ${quote(decode(v.pattern))} input`)
        assert.equal(actual.stdout, '')
        assert.equal(actual.exitCode, 2)
        assert.notEqual(actual.stderr, '')
        assert.deepEqual(actual.unsupported, [])
      })
    }
  }
})

// GNU's single-digit references require prior, participating captures:
// https://www.gnu.org/software/grep/manual/html_node/Back_002dreferences-and-Subexpressions.html
// https://www.gnu.org/software/grep/manual/html_node/Basic-vs-Extended.html
const REGRESSIONS = [
  [String.raw`grep 'a\(*\)b' input`, 'a*b\nab\n', 'a*b\n'],
  [String.raw`grep 'a\(**\)b' input`, 'a*b\nab\na**b\n', 'a*b\nab\na**b\n'],
  [String.raw`grep '^a\|*b' input`, '*b\nb\naa\n', '*b\naa\n'],
  [String.raw`grep 'a\+\?' input`, 'b\na\n', 'b\na\n'],
  [String.raw`grep -o 'a\+\?' input`, 'aaa\n', 'aaa\n'],
  [String.raw`grep 'a\?\+' input`, 'b\naa\n', 'b\naa\n'],
  [String.raw`grep '\\(^' input`, '\\(^\n', '\\(^\n'],
  [String.raw`grep '\\(*' input`, '\\((\n', '\\((\n'],
  [String.raw`grep '\(a\)\12' input`, 'aa2\naa\n', 'aa2\n'],
  [String.raw`grep -E '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)\12' input`, 'abcdefghij kla2\nabcdefghijkla2\nabcdefghijkll\n', 'abcdefghijkla2\n'],
  [String.raw`grep -E '(a)?(b)\2' input`, 'abb\nbb\nab\n', 'abb\nbb\n'],
  [String.raw`grep -E '(a)(b)?\1' input`, 'aa\naba\nab\n', 'aa\naba\n'],
  [String.raw`grep -E 'a{,2}(b)\1' input`, 'bb\naabb\nab\n', 'bb\naabb\n'],
  [String.raw`grep -E '^a{,2}$' input`, '\na\naa\naaa\n', '\na\naa\n'],
  [String.raw`grep '^a\{,2\}$' input`, '\na\naa\naaa\n', '\na\naa\n'],
  [String.raw`grep -wE 'a{,2}' input`, 'a\naa\naaa\nba\n', 'a\naa\n'],
  [String.raw`grep -oE 'a{,2}' input`, 'aaab\n', 'aa\na\n'],
  [String.raw`grep -o 'a\{,\}' input`, 'baaa\n', 'aaa\n'],
  [String.raw`grep 'a**' input`, 'aaa\nb\n', 'aaa\nb\n'],
  [String.raw`grep 'a\b*' input`, 'a*\na\n', 'a*\n'],
  [String.raw`grep -o '\b*' input`, 'a*\nb\n', '*\n'],
  [String.raw`grep '\(\+\)' input`, '+\na\n', '+\n'],
]

describe('GNU regex regressions exposed by the upstream audit', () => {
  for (const [command, input, stdout] of REGRESSIONS) {
    it(command, () => {
      assert.deepEqual(createTerminal({ input }).run(command), result(stdout))
    })
  }
  for (const pattern of [String.raw`(a)*\1`, String.raw`(a)?\1`, String.raw`(a)|b\1`, String.raw`((a)?b)+\2`, String.raw`^(a*)+\1$`, String.raw`^(a*){2}\1$`]) {
    it(`diagnoses conditional reference: ${pattern}`, () => {
      checkGap(createTerminal({ input: 'a\nb\n' }).run(`grep -E -e ${quote(pattern)} input`), 'conditional backreference')
    })
  }
  for (const pattern of [String.raw`(a)\1]`, String.raw`a{z}(b)\1`, String.raw`(a)\1{`]) {
    it(`diagnoses GNU syntax gaps beside valid references: ${pattern}`, () => {
      checkGap(createTerminal({ input: 'aa]\nbb\naa{\n' }).run(`grep -E -e ${quote(pattern)} input`), 'GNU regex syntax')
    })
  }
  for (const [mode, pattern] of [['-E', 'a{,32768}'], ['', String.raw`a\{,32768\}`]]) {
    it(`checks GNU repetition bounds with an omitted minimum: ${pattern}`, () => {
      const actual = createTerminal({ input: 'a\n' }).run(`grep ${mode} -e ${quote(pattern)} input`)
      assert.equal(actual.exitCode, 2)
      assert.match(actual.stderr, /Regular expression too big/u)
      assert.deepEqual(actual.unsupported, [])
    })
  }
  for (const pattern of [String.raw`(a)\1(`, String.raw`(a)\1[`, String.raw`(a)\1{2,1}`]) {
    it(`invalid syntax stays an ordinary error beside valid references: ${pattern}`, () => {
      const actual = createTerminal({ input: 'aa\n' }).run(`grep -E -e ${quote(pattern)} input`)
      assert.equal(actual.exitCode, 2)
      assert.notEqual(actual.stderr, '')
      assert.deepEqual(actual.unsupported, [])
    })
  }
  for (const pattern of [String.raw`(\1a)`, String.raw`\1(a)`, String.raw`(a)(b\2)`, String.raw`((a)\1)`]) {
    it(`rejects reference before group closes: ${pattern}`, () => {
      const actual = createTerminal({ input: 'a\nab\n' }).run(`grep -E -e ${quote(pattern)} input`)
      assert.equal(actual.exitCode, 2)
      assert.match(actual.stderr, /[Ii]nvalid back reference/u)
      assert.deepEqual(actual.unsupported, [])
    })
  }
})
