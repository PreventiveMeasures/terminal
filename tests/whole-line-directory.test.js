import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTerminal } from '@preventive/terminal'

const FILES = {
  lines: 'a\nab\nba\nb\n\nA\n@\na b\na\r\né\n',
  endings: 'a\ra\na\u2028\na\u2029\na\n',
  fixed: 'a.b\naxb\nprefix a.b\na.b suffix\n',
  repeats: 'aa\naaaa\naab\naa\n',
  blank: '\n',
  empty: '',
  ascii: 'a\nab\nA\n',
  'src/a.js': 'a\nab\n',
  'src/b.txt': 'a\n',
}

function check(line, stdout, exitCode = 0, files = FILES) {
  const result = createTerminal(files).run(line)
  assert.equal(result.stdout, stdout, line)
  assert.equal(result.stderr, '', line)
  assert.equal(result.exitCode, exitCode, line)
  assert.deepEqual(result.unsupported, [], line)
}

describe('grep -x selects complete lines', () => {
  for (const [line, stdout, exitCode = 0] of [
    ["grep -xn a lines", '1:a\n'],
    ["grep -xEn 'a|ab' lines", '1:a\n2:ab\n'],
    [String.raw`grep -xn 'a\|b' lines`, '1:a\n4:b\n'],
    ["grep -xFn a.b fixed", '1:a.b\n'],
    ["grep -xF é lines", 'é\n'],
    ["grep -xin a ascii", '1:a\n3:A\n'],
    ["grep -xvn a lines", '2:ab\n3:ba\n4:b\n5:\n6:A\n7:@\n8:a b\n9:a\r\n10:é\n'],
    ["grep -xn '' lines", '5:\n'],
    ["grep -xF '' blank", '\n'],
    ["grep -x '' empty", '', 1],
    ["grep -xE 'a*' blank", '\n'],
    ["grep -xF -e a -e b -e a lines", 'a\nb\n'],
    ["grep -xc -e a -e b lines", '2\n'],
    ["grep -xq a lines", ''],
    ["grep -xq missing lines", '', 1],
    ["grep -xl a empty lines", 'lines\n'],
    ["grep -xL a empty lines", 'empty\n'],
    ["grep -x a endings", 'a\n'],
    ["grep -x '^a$' endings", 'a\n'],
    ["grep -xFn 'a' endings", '4:a\n'],
    ["grep -xw '@' lines", '@\n'],
    ["grep -xwF é lines", 'é\n'],
    ["grep -xw '' lines", '\n'],
    ["grep -rxn a src --include=*.js", 'src/a.js:1:a\n'],
    ["grep -xn -A1 -B1 b lines", '3-ba\n4:b\n5-\n'],
    [String.raw`printf '%s\n' ab a | grep -x a`, 'a\n'],
  ]) {
    it(line, () => check(line, stdout, exitCode))
  }
})

describe('grep -xo emits full matches without changing capture numbering', () => {
  for (const [line, stdout, exitCode = 0] of [
    ["grep -xEon 'a|ab' lines", '1:a\n2:ab\n'],
    ["grep -xFo a.b fixed", 'a.b\n'],
    ["grep -xwo @ lines", '@\n'],
    [String.raw`grep -xo '\(a\)\1' repeats`, 'aa\naa\n'],
    [String.raw`grep -xEo '(a)\1' repeats`, 'aa\naa\n'],
    [String.raw`grep -xo -e '\(a\)\1' -e '\(b\)\1' repeats`, 'aa\naa\n'],
    ["grep -xoc aa repeats", '2\n'],
    ["grep -xom1 aa repeats", 'aa\n'],
    ["grep -xo '' blank", ''],
    ["grep -xov a lines", ''],
    ["grep -xo a empty", '', 1],
    ["grep -xFo é lines", 'é\n'],
  ]) {
    it(line, () => check(line, stdout, exitCode))
  }
})

describe('grep -x retains unsupported diagnostics', () => {
  for (const [line, files, detail] of [
    ["grep -x . text", { text: 'é\n' }, 'non-ASCII regex semantics'],
    ["grep -xF a binary", { binary: 'a\0b\n' }, 'binary input'],
    ["grep -x a binary", { binary: 'a\0b\n' }, 'binary input'],
    ["grep -xP '(?i)a' lines", FILES, 'PCRE group'],
  ]) {
    it(line, () => {
      const result = createTerminal(files).run(`${line} 2>/dev/null | cat`)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported.map((entry) => entry.detail), [detail])
      assert.equal(result.unsupported[0].command, 'grep')
    })
  }
})

const TREE = { 'a/x': '', 'a/nested/z': '', 'b/y': '', z: '', '.hidden': '' }

describe('ls -d lists operands themselves', () => {
  for (const [line, stdout] of [
    ['ls -d', '.\n'],
    ['ls -da', '.\n'],
    ['ls -dA', '.\n'],
    ['ls -d b a z', 'a\nb\nz\n'],
    ['ls -dr b a z', 'z\nb\na\n'],
    ['ls -d . .. /', '.\n..\n/\n'],
    ['ls -d a a', 'a\na\n'],
    ['ls -d *', 'a\nb\nz\n'],
    ['ls -d */', 'a/\nb/\n'],
    ['ls -d a/*', 'a/nested\na/x\n'],
    ['ls -d .hidden', '.hidden\n'],
    ['ls -dF . a a/ z', './\na/\na/\nz\n'],
    ['ls -dR a', 'a\n'],
    ['ls -d1 a b', 'a\nb\n'],
    ['cd a && ls -d . ../b', '.\n../b\n'],
  ]) {
    it(line, () => check(line, stdout, 0, TREE))
  }

  it('keeps valid operands when another lookup fails', () => {
    const result = createTerminal(TREE).run('ls -d a missing z/../b')
    assert.equal(result.stdout, 'a\n')
    assert.equal(result.exitCode, 2)
    assert.match(result.stderr, /ls: missing: no such file or directory/u)
    assert.match(result.stderr, /ls: z\/\.\.\/b: not a directory/u)
    assert.deepEqual(result.unsupported, [])
  })

  for (const line of ['ls -ld a', 'ls -dl .', 'ls -ld */']) {
    it(`${line} reports unavailable metadata through redirects and pipes`, () => {
      const result = createTerminal(TREE).run(`${line} 2>/dev/null | cat`)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported.map((entry) => entry.detail), ['-l metadata'])
      assert.equal(result.unsupported[0].command, 'ls')
    })
  }
})
