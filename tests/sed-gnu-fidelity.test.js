import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// What GNU sed 4.9 answers, taken from the real tool: compile.c's
// match_slash leaves a backslash in a bracket to the regex, which reads it
// as itself; stdout goes through stdio, a block of 4096 bytes at a time to a
// pipe or a file and a line at a time to a terminal, while stderr is
// written at once; and utils.c's ck_fopen and ck_rename panic, status 4.
// https://github.com/mirror/sed/blob/v4.9/sed/compile.c
// https://github.com/mirror/sed/blob/v4.9/sed/utils.c
const result = (stdout = '', stderr = '', exitCode = 0, cwd = '/src') => ({ stdout, stderr, exitCode, cwd, notes: [], unsupported: [] })
const terminal = () => createTerminal({
  input: 'one\ntwo\nthree\n',
  marks: 'a\\b.c d\te\n',
  wide: 'x' + 'é'.repeat(3000) + '\n',
}, { mount: '/src', writable: '/tmp/' })
const missing = "sed: can't read nofile: No such file or directory\n"

describe('sed brackets read a backslash as GNU does', () => {
  const cases = [
    [String.raw`s/[\]/X/`, 'marks', 'aXb.c d\te\n'],
    [String.raw`s/[\.]/X/g`, 'marks', 'aXbXc d\te\n'],
    [String.raw`s/[ \t]/_/g`, 'marks', 'a\\b.c_d_e\n'],
    [String.raw`N;s/[\n]/,/`, 'input', 'one,two\nthree\n'],
    [String.raw`N;s/[^\n]*$/X/`, 'input', 'one\nX\nthree\n'],
  ]
  for (const [script, file, stdout] of cases) {
    it(script, async () => {
      assert.deepEqual(await terminal().run(`cd /src; sed '${script}' ${file}`), result(stdout))
    })
  }

  it('ends a range at a backslash', async () => {
    assert.deepEqual(await terminal().run(String.raw`cd /src; sed 's/[a-\]/X/g' marks`),
      result('', 'sed: -e expression #1, char 11: Invalid range end\n', 1))
  })
})

describe('sed stdout reaches a shared destination in stdio order', () => {
  it('lands a diagnostic ahead of output still held for a pipe', async () => {
    assert.deepEqual(await terminal().run('cd /src; sed p input nofile 2>&1 | cat'),
      result(missing + 'one\none\ntwo\ntwo\nthree\nthree\n'))
  })

  it('lands a diagnostic after the blocks already written', async () => {
    assert.deepEqual(await terminal().run(`seq 1 2000 > /tmp/s; sed p /tmp/s nofile 2>&1 | grep -n "can't"`),
      result('3720:186' + missing))
  })

  it('writes a line at a time to the terminal', async () => {
    assert.deepEqual(await terminal().run('cd /src; sed -n p input nofile 2>&1'), result('one\ntwo\nthree\n' + missing, '', 2))
  })

  it('writes w /dev/stderr at once, ahead of held stdout', async () => {
    assert.deepEqual(await terminal().run("cd /src; sed 'w /dev/stderr' input 2>&1 | cat"),
      result('one\ntwo\nthree\none\ntwo\nthree\n'))
  })

  it('refuses a diagnostic that stdio would write inside a character', async () => {
    const actual = await terminal().run('cd /src; sed p wide nofile 2>&1 | cat')
    assert.deepEqual(actual.unsupported.map(({ detail }) => detail), ['combined output ordering'])
  })
})

describe('sed open and rename failures are panics', () => {
  it('cannot open a w file in a directory that is not there', async () => {
    assert.deepEqual(await terminal().run("cd /src; sed 'w /tmp/nodir/x' input"),
      result('', "sed: couldn't open file /tmp/nodir/x: No such file or directory\n", 4))
  })

  it('cannot open a w file under a file', async () => {
    assert.deepEqual(await terminal().run("touch /tmp/f; cd /src; sed 's/o/0/w /tmp/f/x' input"),
      result('', "sed: couldn't open file /tmp/f/x: Not a directory\n", 4))
  })

  it('cannot rename the input to a backup that names a directory', async () => {
    assert.deepEqual(await terminal().run("cp /src/input /tmp/a; cd /tmp; sed -i'b/' 's/o/0/' a"),
      result('', 'sed: cannot rename a: Not a directory\n', 4, '/tmp'))
    assert.deepEqual(await terminal().run("mkdir /tmp/b; cp /src/input /tmp/a; cd /tmp; sed -i'/' 's/o/0/' a"),
      result('', 'sed: cannot rename a: Not a directory\n', 4, '/tmp'))
  })

  it('cannot rename the input over a directory', async () => {
    const t = terminal()
    assert.deepEqual(await t.run('cp /src/input /tmp/a; mkdir /tmp/a.bak; sed -i.bak p /tmp/a'),
      result('', 'sed: cannot rename /tmp/a: Is a directory\n', 4))
    assert.deepEqual(await t.run('cat /tmp/a'), result('one\ntwo\nthree\n'))
  })

  it('cannot write a full block to a closed stdout', async () => {
    assert.deepEqual(await terminal().run('seq 1 2000 > /tmp/big; sed p /tmp/big >&-'),
      result('', "sed: couldn't write 3 items to stdout: Bad file descriptor\n", 4))
  })
})

describe('sed counts its step budget between reads', () => {
  it('runs a long input through several commands a line', async () => {
    assert.deepEqual(await terminal().run(String.raw`seq 1 300000 | sed -n 's/1/X/;s/2/Y/;s/3/Z/;$p'`), result('Z00000\n'))
  })
})
