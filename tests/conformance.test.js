import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { hrtime } from 'node:process'
import { describe, it } from 'node:test'
import { URL } from 'node:url'
import { createTerminal } from '@preventive/terminal'
import { TREES } from './fixtures/conformance/trees.js'

// A data-driven conformance corpus: one line per case, so adding coverage
// means adding a line. Every expectation was recorded from the real tool —
// bash 5.2.21, GNU grep 3.11, GNU sed 4.9, gawk 5.2.1, all in the C locale —
// never from what this implementation happened to print.
//
//   command       => "stdout"           that output, exit 0, nothing on the feed
//   command       => "stdout" 2         that output and that status
//   command       => "stdout" 0 +$u     that output, and an advisory note on the feed
//   command       => ! detail 1         refused: that note on the feed, that status
//   command       => % 2                a plain error: stderr, that status, no note
//   command       => ~ 1000             finishes inside that budget
//   "cmd\nline2"   => "stdout"           a JSON-quoted command, for one spanning lines
//
// A line starting with `@` sets state for the lines that follow:
//
//   @tree glob                     use that fixture tree (see trees.js)
//   @mode overlay                  run in the writable /tmp overlay
//   @mode readonly                 run on a read-only mount (the default)
//
// The three failure shapes are deliberately distinct, because which one a
// command produces is itself the behaviour under test. `!` is a gap this
// implementation knows it has and reports on the diagnostic feed. `%` is an
// ordinary runtime error a real tool also produces — a malformed pattern, a
// missing file — carried on stderr and off the feed, because it is the
// caller's mistake rather than a missing feature. `+` is neither: the answer
// is right and the feed carries advice alongside it.
//
// A refusal is the other half of correctness: where an answer would depend
// on something this implementation does not have — a locale, a GNU regex
// extension, a writable source tree — returning nothing and saying why is
// the only result that is never wrong. Those cases carry `!` and assert a
// non-zero status plus the diagnostic, so a future change cannot quietly
// start guessing instead.

const DIR = new URL('./fixtures/conformance/', import.meta.url)
const FILES = readdirSync(DIR).filter((name) => name.endsWith('.tests')).sort()

export function parse(text, file) {
  const cases = []
  let tree = 'trees'
  let mode = 'readonly'
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    const at = `${file}:${index + 1}`
    if (!line || line.startsWith('#')) return
    if (line.startsWith('@')) {
      const [directive, value] = line.slice(1).split(/\s+/u)
      if (directive === 'tree') {
        assert.ok(TREES[value], `${at}: unknown tree ${value}`)
        tree = value
      } else if (directive === 'mode') {
        assert.ok(value === 'overlay' || value === 'readonly', `${at}: unknown mode ${value}`)
        mode = value
      } else assert.fail(`${at}: unknown directive ${directive}`)
      return
    }
    // A command is bare text up to ` => `, unless it is JSON-quoted, which
    // is how a command that spans lines fits on one corpus line.
    let command, expect
    if (line.startsWith('"')) {
      const end = closingQuote(line, at)
      command = JSON.parse(line.slice(0, end + 1))
      const rest = line.slice(end + 1).trimStart()
      assert.ok(rest.startsWith('=> '), `${at}: no ' => ' after the quoted command`)
      expect = rest.slice(3).trim()
    } else {
      const split = line.lastIndexOf(' => ')
      assert.notEqual(split, -1, `${at}: no ' => ' in ${JSON.stringify(line)}`)
      command = line.slice(0, split).trim()
      expect = line.slice(split + 4).trim()
    }
    cases.push({ at, tree, mode, command, ...expectation(expect, at) })
  })
  return cases
}

function expectation(expect, at) {
  if (expect.startsWith('%')) return { errorExit: Number(expect.slice(1).trim()) }
  if (expect.startsWith('~')) return { budgetMs: Number(expect.slice(1).trim()) }
  if (expect.startsWith('!')) {
    // `! detail` or `! detail <exit>`: the exit status of a refusal depends
    // on what surrounds it, so a compound command pins its own.
    const body = expect.slice(1).trim()
    const tail = body.lastIndexOf(' ')
    const exit = tail === -1 ? Number.NaN : Number(body.slice(tail + 1))
    return Number.isInteger(exit)
      ? { refusal: body.slice(0, tail).trim(), exitCode: exit }
      : { refusal: body }
  }
  const end = closingQuote(expect, at)
  const stdout = JSON.parse(expect.slice(0, end + 1))
  const rest = expect.slice(end + 1).trim()
  const [status, note] = rest.split(/\s+(?=\+)/u)
  return {
    stdout,
    exitCode: status === undefined || status === '' ? 0 : Number(status),
    note: note === undefined ? undefined : note.slice(1),
  }
}

// The stdout field is a JSON string; find its close without tripping on an
// escaped quote inside it.
function closingQuote(expect, at) {
  assert.ok(expect.startsWith('"'), `${at}: expectation must be a JSON string, ! or ~`)
  for (let i = 1; i < expect.length; i++) {
    if (expect[i] === '\\') i++
    else if (expect[i] === '"') return i
  }
  assert.fail(`${at}: unterminated string`)
}

// The overlay mounts sources away from /tmp and copies them in, which is how
// a workflow gets somewhere to write without the source tree becoming
// writable. Read-only mounts stay at / so paths in a case read naturally.
function terminalFor({ tree, mode }) {
  const files = TREES[tree]
  if (mode === 'readonly') return createTerminal(files)
  const terminal = createTerminal(files, { mount: '/work', cwd: '/work', writable: '/tmp/' })
  for (const name of Object.keys(files)) {
    const copy = terminal.run(`cp ${name} /tmp/${name}`)
    assert.equal(copy.exitCode, 0, `copying ${name} into the overlay: ${copy.stderr}`)
  }
  assert.equal(terminal.run('cd /tmp').exitCode, 0)
  return terminal
}

function check(entry) {
  const terminal = terminalFor(entry)
  const started = hrtime.bigint()
  const result = terminal.run(entry.command)
  const ms = Number(hrtime.bigint() - started) / 1e6
  if (entry.budgetMs !== undefined) {
    assert.deepEqual(result.unsupported, [], `${entry.at}: a budget case must not be refused`)
    assert.ok(ms < entry.budgetMs, `${entry.at}: took ${ms.toFixed(0)}ms, budget ${entry.budgetMs}ms`)
    return
  }
  if (entry.errorExit !== undefined) {
    assert.equal(result.exitCode, entry.errorExit, entry.at)
    assert.equal(result.stdout, '', `${entry.at}: a failing command must not also produce output`)
    assert.notEqual(result.stderr.trim(), '', `${entry.at}: a plain error must say something on stderr`)
    assert.deepEqual(result.unsupported, [], `${entry.at}: an ordinary error is not an unsupported feature`)
    return
  }
  if (entry.refusal !== undefined) {
    assert.equal(result.unsupported.length, 1, `${entry.at}: the refusal must reach the diagnostic feed`)
    assert.equal(result.unsupported[0].detail, entry.refusal, entry.at)
    assert.ok(result.stderr.includes(result.unsupported[0].message), `${entry.at}: stderr must carry the message`)
    if (entry.exitCode !== undefined) assert.equal(result.exitCode, entry.exitCode, entry.at)
    return
  }
  assert.deepEqual({ stdout: result.stdout, exitCode: result.exitCode },
    { stdout: entry.stdout, exitCode: entry.exitCode }, entry.at)
  if (entry.note === undefined) {
    assert.deepEqual(result.unsupported, [], `${entry.at}: a plain answer carries nothing on the feed`)
    assert.equal(result.stderr, '', entry.at)
  } else {
    assert.equal(result.unsupported.length, 1, `${entry.at}: expected a note on the feed`)
    assert.equal(result.unsupported[0].detail, entry.note, entry.at)
  }
}

function describeExpectation(entry) {
  if (entry.refusal !== undefined) return '! ' + entry.refusal
  if (entry.errorExit !== undefined) return '% ' + entry.errorExit
  if (entry.budgetMs !== undefined) return '~ ' + entry.budgetMs
  return JSON.stringify(entry.stdout) + (entry.exitCode ? ' ' + entry.exitCode : '') +
    (entry.note === undefined ? '' : ' +' + entry.note)
}

describe('conformance corpus', () => {
  it('loads every corpus file', () => {
    assert.ok(FILES.length > 3, `expected corpus files, found ${FILES.length}`)
  })

  for (const file of FILES) {
    const cases = parse(readFileSync(new URL(file, DIR), 'utf8'), file)
    describe(file, () => {
      it('holds cases', () => assert.ok(cases.length > 0, file))
      for (const entry of cases) {
        it(`${JSON.stringify(entry.command)} => ${describeExpectation(entry)}`, () => check(entry))
      }
    })
  }
})
