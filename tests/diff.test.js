import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { parse } from './conformance.test.js'
import { TREES } from './fixtures/conformance/trees.js'
import { splitRecords } from '../src/diff/compare.js'
import { formatContext, formatUnified } from '../src/diff/format.js'
import { verifyChangeSet } from '../src/diff/myers.js'
import { createScanner, nextHunk } from '../src/commands/patch-parse.js'

// What the corpus cannot say: that the diagnostic feed carries every
// refusal, that the format is GNU's for GNU's own change set, and that a
// change set which reaches the formatter has passed the replay check.

const run = (line, files = TREES.pair, opts = {}) => createTerminal(files, opts).run(line)

describe('diff refuses what it does not do, on the feed', () => {
  for (const [line, detail] of [
    ['diff -y ten ten2', '-y'], ['diff --side-by-side ten ten2', '--side-by-side'], ['diff -e ten ten2', '-e'], ['diff -n ten ten2', '-n'],
    ['diff -B ten ten2', '-B'], ['diff -I x ten ten2', '-I'], ['diff -D SYM ten ten2', '-D'], ['diff -t ten ten2', '-t'], ['diff -T ten ten2', '-T'],
    ['diff -W 80 ten ten2', '-W'], ['diff --color=never ten ten2', '--color'], ['diff --color ten ten2', '--color'], ['diff -F ^int ten ten2', '-F'],
    ['diff --from-file=ten ten2', '--from-file'], ['diff -X list ten ten2', '-X'], ['diff -S start ten ten2', '-S'], ['diff -v', '-v'], ['diff --help', '--help'],
    ['diff --bogus ten ten2', '--bogus'], ['diff -Q ten ten2', '-Q'], ['diff --ignore-blank-lines ten ten2', '--ignore-blank-lines'], ['diff -P ten ten2', '-P'],
  ]) {
    it(line, () => {
      const r = run(line + ' 2>/dev/null || true')
      assert.deepEqual(r.unsupported.map((u) => [u.kind, u.command, u.detail]), [['option', 'diff', detail]], line)
      assert.equal(run(line).exitCode, 2, line)
      assert.notEqual(run(line).stderr, '', line)
    })
  }
  it('says nothing on the feed for ordinary trouble', () => {
    const r = run('diff nope ten')
    assert.deepEqual(r.unsupported, [])
    assert.equal(r.exitCode, 2)
    assert.equal(r.stderr, 'diff: nope: No such file or directory\n')
  })
  it('notes a relative operand that exists elsewhere', () => {
    const t = createTerminal({ 'a/x': '1\n', x: '2\n' }, { cwd: '/a' })
    const r = t.run('diff x ../x')
    assert.equal(r.exitCode, 1)
    const missing = t.run('diff y x')
    assert.deepEqual(missing.notes, [])
    assert.deepEqual(createTerminal({ 'a/x': '1\n', y: '2\n' }, { cwd: '/a' }).run('diff y x').notes, ['diff: relative path "y" was not found from cwd "/a". A file exists at "/y".'])
  })
})

describe('diff through the shell', () => {
  it('reads standard input for - and consumes it', () => {
    assert.deepEqual(run("printf 'x\\n' | { diff - a1; cat; }").stdout, '1c1\n< x\n---\n> a\n')
    assert.equal(run("printf 'x\\n' | diff -u a1 - | head -2").stdout, '--- a1\n+++ -\n')
  })
  it('exit status gates a chain and is noted when it cancels one', () => {
    const r = run('diff ten ten2 > /dev/null && echo same')
    assert.equal(r.stdout, '')
    assert.deepEqual(r.notes, ['diff: exited 1, so the command after && did not run.'])
    assert.equal(run('diff ten ten && echo same').stdout, 'same\n')
  })
  it('dispatches through xargs and find with the usual status', () => {
    assert.equal(run('echo ten ten2 | xargs diff').exitCode, 123)
    assert.equal(run('echo ten ten2 | xargs diff').stdout, '3c3\n< c\n---\n> X\n9c9\n< i\n---\n> Y\n')
    assert.equal(run("find . -name ten -exec diff {} ten2 ';'").stdout, '3c3\n< c\n---\n> X\n9c9\n< i\n---\n> Y\n')
  })
  it('a directory pair given twice is nothing to compare', () => {
    assert.deepEqual(run('diff -rs d1 d1; echo $?', TREES.dirs).stdout, '0\n')
    assert.deepEqual(run('diff -rs d1/sub ./d1/sub; echo $?', TREES.dirs).stdout, '0\n')
  })
  it('quotes a name in a header only when it needs it, by the locale', () => {
    const t = createTerminal({ 'ünï': 'v\n', a1: 'a\n' })
    assert.equal(t.run('diff -u ünï a1 | head -1').stdout, '--- ünï\n')
    assert.equal(t.run('LC_ALL=C diff -u ünï a1 | head -1').stdout, '--- "\\303\\274n\\303\\257"\n')
    assert.equal(t.run("diff -u 'sp ace' a1 2>&1 | head -1", TREES.pair).stdout, 'diff: sp ace: No such file or directory\n')
  })
})

// A unified diff read back into the change set it prints: each hunk's runs
// of - and + at the same point are one block, positioned by the header.
function changeSetOf(text) {
  const scanner = createScanner(text)
  scanner.pos = scanner.lines.findIndex((line) => line.startsWith('@@ '))
  const blocks = []
  for (let hunk = nextHunk(scanner, 'unified'); hunk; hunk = nextHunk(scanner, 'unified')) {
    let a = hunk.oldStart - 1, b = hunk.newStart - 1
    let ni = 0, oi = 0
    while (oi < hunk.oldLines.length || ni < hunk.newLines.length) {
      if (hunk.oldLines[oi]?.tag === ' ' && hunk.newLines[ni]?.tag === ' ') { oi++; ni++; a++; b++; continue }
      const block = { a0: a, a1: a, b0: b, b1: b }
      while (hunk.oldLines[oi]?.tag === '-') { oi++; block.a1++ }
      while (hunk.newLines[ni]?.tag === '+') { ni++; block.b1++ }
      blocks.push(block)
      a = block.a1
      b = block.b1
    }
  }
  return blocks
}

describe('given GNU\'s own change set, the rendering is GNU\'s, byte for byte', () => {
  // Every `diff -u` and `diff -c` case the corpus recorded from GNU diff
  // whose operands are two plain files: the recorded unified output says
  // which change set GNU chose; rendering that change set here has to
  // reproduce the recording exactly, in both styles.
  const corpus = parse(readFileSync(import.meta.dirname + '/fixtures/conformance/diff.tests', 'utf8'), 'diff.tests')
  const unified = new Map()
  for (const entry of corpus) {
    const m = /^diff -u (\S+) (\S+)$/u.exec(entry.command)
    if (m && entry.stdout !== undefined && TREES[entry.tree][m[1]] !== undefined && TREES[entry.tree][m[2]] !== undefined) unified.set(entry.command, { ...entry, names: [m[1], m[2]] })
  }
  assert.ok(unified.size >= 10, 'the corpus should hold a fair number of plain unified cases')
  for (const [command, entry] of unified) {
    it(command, () => {
      const files = TREES[entry.tree]
      const a = splitRecords(files[entry.names[0]]), b = splitRecords(files[entry.names[1]])
      const blocks = changeSetOf(entry.stdout)
      verifyChangeSet(a, b, blocks)
      const header = entry.stdout.split('\n').slice(0, 2).join('\n') + '\n'
      assert.equal(formatUnified(a, b, blocks, { context: 3, header, fn: null }), entry.stdout)
      const contextCase = corpus.find((other) => other.command === command.replace('-u', '-c'))
      if (contextCase?.stdout === undefined) return
      const contextHeader = contextCase.stdout.split('\n').slice(0, 2).join('\n') + '\n'
      assert.equal(formatContext(a, b, blocks, { context: 3, header: contextHeader, fn: null }), contextCase.stdout)
    })
  }
})
