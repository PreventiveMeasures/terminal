import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const SOURCES = { first: 'first\n', second: 'second\n', empty: '', unicode: 'é😀\n' }
const terminal = () => createTerminal(SOURCES, { mount: '/repo', cwd: '/repo', writable: '/tmp/' })
const diagnostic = (name = '/tmp/log') => `cat: ${name}: input file is output file\n`

function check(t, command, stdout = '', stderr = '', exitCode = 0, notes = []) {
  assert.deepEqual(t.run(command), { stdout, stderr, exitCode, cwd: '/repo', notes, unsupported: [] }, command)
}

// GNU coreutils src/cat.c compares input position against stdout's current
// position, or its file end when O_APPEND is set, before reading each operand.
describe('cat rejects a file that is behind its own output position', () => {
  for (const flags of ['', '-n ', '-b ', '-s ', '-A ', '-v ', '-E ', '-T ']) {
    it(`rejects nonempty self-append with ${flags || 'no flags'}`, () => {
      const t = terminal()
      check(t, 'cat first >/tmp/log')
      check(t, `cat ${flags}/tmp/log >>/tmp/log`, '', diagnostic(), 1)
      check(t, 'cat /tmp/log', 'first\n')
    })
  }

  for (const [operand, name] of [['', '-'], ['-', '-'], ['/dev/stdin', '/dev/stdin']]) {
    it(`rejects redirected stdin through ${operand || 'the implicit operand'}`, () => {
      const t = terminal()
      check(t, 'cat first >/tmp/log')
      check(t, `cat ${operand} </tmp/log >>/tmp/log`, '', diagnostic(name), 1)
      check(t, 'cat /tmp/log', 'first\n')
    })
  }

  it('recognizes normalized aliases of the output path', () => {
    const t = terminal()
    check(t, 'cat first >/tmp/log')
    check(t, 'cat ../tmp/./log >>/tmp/log', '', diagnostic('../tmp/./log'), 1)
    check(t, 'cat /tmp/log', 'first\n')
  })

  it('reports each rejected operand and continues copying other files', () => {
    const t = terminal()
    check(t, 'cat first >/tmp/log')
    check(t, 'cat /tmp/log second /tmp/log first >>/tmp/log', '', diagnostic().repeat(2), 1)
    check(t, 'cat /tmp/log', 'first\nsecond\nfirst\n')
  })

  it('accounts for earlier operands when the output file was initially empty', () => {
    const t = terminal()
    check(t, 'cat first /tmp/log second >/tmp/log', '', diagnostic(), 1)
    check(t, 'cat /tmp/log', 'first\nsecond\n')
  })

  it('preserves line-number state across a skipped self operand', () => {
    const t = terminal()
    check(t, 'cat -n first /tmp/log second >/tmp/log', '', diagnostic(), 1)
    check(t, 'cat /tmp/log', '     1\tfirst\n     2\tsecond\n')
  })

  it('does not consume rejected standard input', () => {
    const t = terminal()
    check(t, 'cat first >/tmp/log')
    check(t, '{ cat >>/tmp/log; cat; } </tmp/log', 'first\n', diagnostic('-'))
    check(t, 'cat /tmp/log', 'first\n')
  })

  it('preserves the unread portion of partially consumed input', () => {
    const t = terminal()
    check(t, 'cat unicode >/tmp/log')
    check(t, '{ head -c2 >/dev/null; cat >>/tmp/log; cat; } </tmp/log', '😀\n', diagnostic('-'), 0, ['head: selected 2 of 7 bytes from "/tmp/log".'])
    check(t, 'cat /tmp/log', 'é😀\n')
  })

  it('reopens /dev/stdin from the beginning even after stdin reaches EOF', () => {
    const t = terminal()
    check(t, 'cat first >/tmp/log')
    check(t, '{ cat >/dev/null; cat /dev/stdin >>/tmp/log; } </tmp/log', '', diagnostic('/dev/stdin'), 1)
    check(t, 'cat /tmp/log', 'first\n')
  })

  it('recognizes stdout redirected through stderr', () => {
    const t = terminal()
    check(t, 'cat first >/tmp/log')
    check(t, 'cat /tmp/log 2>>/tmp/log 1>&2', '', '', 1)
    check(t, 'cat /tmp/log', 'first\n' + diagnostic())
  })

  it('keeps ordinary self-output errors out of the unsupported channel when stderr is suppressed', () => {
    const t = terminal()
    check(t, 'cat first >/tmp/log')
    check(t, 'cat /tmp/log >>/tmp/log 2>/dev/null', '', '', 1)
    check(t, 'cat /tmp/log', 'first\n')
  })
})

describe('cat allows empty inputs and safe descriptor positions', () => {
  for (const command of [
    'cat /tmp/log >/tmp/log',
    'cat -n /tmp/log >/tmp/log',
    'cat </tmp/log >/tmp/log',
    'cat >/tmp/log </tmp/log',
    'cat /dev/stdin </tmp/log >/tmp/log',
  ]) {
    it(`allows truncation before reading: ${command}`, () => {
      const t = terminal()
      check(t, 'cat first >/tmp/log')
      check(t, command)
      check(t, 'cat /tmp/log')
    })
  }

  for (const command of ['cat /tmp/log >>/tmp/log', 'cat -n /tmp/log >>/tmp/log', 'cat </tmp/log >>/tmp/log']) {
    it(`allows an empty self-append: ${command}`, () => {
      const t = terminal()
      check(t, 'cat empty >/tmp/log')
      check(t, command)
      check(t, 'cat /tmp/log')
    })
  }

  it('allows stdin at EOF even when the output file is nonempty', () => {
    const t = terminal()
    check(t, 'cat unicode >/tmp/log')
    check(t, '{ cat >/dev/null; cat >>/tmp/log; } </tmp/log')
    check(t, 'cat /tmp/log', 'é😀\n')
  })

  it('allows distinct files with the same content', () => {
    const t = terminal()
    check(t, 'cat first >/tmp/log; cat first >/tmp/other')
    check(t, 'cat /tmp/other >>/tmp/log')
    check(t, 'cat /tmp/log', 'first\nfirst\n')
  })

  it('does not confuse a pipe destination with the later file destination', () => {
    const t = terminal()
    check(t, 'cat first >/tmp/log')
    check(t, 'cat second | cat >>/tmp/log')
    check(t, 'cat /tmp/log', 'first\nsecond\n')
  })

  it('uses an inherited nonappend output offset rather than the file size', () => {
    const t = terminal()
    check(t, '{ cat first >/tmp/log; cat /tmp/log; } >/tmp/log')
    check(t, 'cat /tmp/log', 'first\n')
  })

  it('allows a nonappend output offset behind the unread input position', () => {
    const t = terminal()
    check(t, "{ printf abcdef >/tmp/log; { head -c2 >/dev/null; cat; } </tmp/log; } >/tmp/log", '', '', 0, ['head: selected 2 of 6 bytes from "/tmp/log".'])
    check(t, 'cat /tmp/log', 'cdefef')
  })

  it('checks invalid path components before identifying the output file', () => {
    const t = terminal()
    check(t, 'cat first >/tmp/log')
    check(t, 'cat /tmp/log/../log >>/tmp/log', '', 'cat: /tmp/log/../log: not a directory\n', 1)
    check(t, 'cat /tmp/log', 'first\n')
  })
})

describe('cat diagnoses self-copy cases that need streaming transformations', () => {
  it('diagnoses transformed nonempty input with equal descriptor positions', () => {
    const t = terminal()
    const r = t.run('{ cat first >/tmp/log; cat -n /tmp/log; } >/tmp/log')
    assert.equal(r.stdout, '')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /transforming an input file/u)
    assert.ok(r.unsupported.some((note) => note.detail === 'cat transforms its input file'))
    check(t, 'cat /tmp/log', 'first\n')
  })

  it('diagnoses input affected by a preceding error on the same output file', () => {
    const t = terminal()
    const r = t.run('cat missing /tmp/log >/tmp/log 2>&1')
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 1)
    assert.ok(r.unsupported.some((note) => note.detail === 'cat input modified by diagnostics'))
    const read = t.run('cat /tmp/log')
    assert.match(read.stdout, /writing diagnostics to the same file/u)
    assert.deepEqual(read.unsupported, [])
  })

  for (const stdout of ['', ' >/tmp/other']) {
    it(`diagnoses stderr modifying a later input with stdout ${stdout || 'captured'}`, () => {
      const t = terminal()
      check(t, 'cat first >/tmp/log')
      const r = t.run(`cat missing /tmp/log 2>>/tmp/log${stdout}`)
      assert.equal(r.stdout, '')
      assert.equal(r.stderr, '')
      assert.equal(r.exitCode, 1)
      assert.ok(r.unsupported.some((note) => note.detail === 'cat input modified by diagnostics'))
    })
  }
})

describe('cat compares open file identities after replacements and unlinks', () => {
  it('rejects a renamed backup that is still the inherited output file', () => {
    const t = terminal()
    check(t, 'printf abc >/tmp/log')
    check(t, "{ sed -i.bak 's/a/A/' /tmp/log; cat /tmp/log.bak; } >>/tmp/log", '', diagnostic('/tmp/log.bak'), 1)
    check(t, 'cat /tmp/log /tmp/log.bak', 'Abcabc')
  })

  it('copies a replacement through the output descriptor for its old inode', () => {
    const t = terminal()
    check(t, 'printf abc >/tmp/log')
    check(t, "{ sed -i.bak 's/a/A/' /tmp/log; cat /tmp/log; } >>/tmp/log")
    check(t, 'cat /tmp/log /tmp/log.bak', 'AbcabcAbc')
  })

  it('does not confuse an unlinked output with a recreated pathname', () => {
    const t = terminal()
    check(t, 'printf old >/tmp/log')
    check(t, '{ rm /tmp/log; printf new >/tmp/log; cat /tmp/log; } >>/tmp/log')
    check(t, 'cat /tmp/log', 'new')
  })

  it('retains the redirected input inode when its pathname is replaced', () => {
    const t = terminal()
    check(t, 'printf abc >/tmp/log')
    check(t, "{ sed -i.bak 's/a/A/' /tmp/log; cat >>/tmp/log.bak; } </tmp/log", '', diagnostic('-'), 1)
    check(t, 'cat /tmp/log /tmp/log.bak', 'Abcabc')
  })

  it('diagnoses pending errors modifying an input through its backup alias', () => {
    const t = terminal()
    check(t, 'printf abc >/tmp/log')
    const result = t.run("{ sed -i.bak 's/a/A/' /tmp/log; cat missing /tmp/log.bak; } 2>>/tmp/log")
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 1)
    assert.ok(result.unsupported.some((note) => note.detail === 'cat input modified by diagnostics'))
    check(t, 'cat /tmp/log', 'Abc')
    assert.match(t.run('cat /tmp/log.bak').stdout, /^abc.*writing diagnostics to the same file/u)
  })

  it('does not reject diagnostics targeting the old inode before reading its replacement', () => {
    const t = terminal()
    check(t, 'printf abc >/tmp/log')
    check(t, "{ sed -i.bak 's/a/A/' /tmp/log; cat missing /tmp/log; } 2>>/tmp/log", 'Abc', '', 1)
    check(t, 'cat /tmp/log', 'Abc')
    check(t, 'cat /tmp/log.bak', 'abccat: missing: no such file or directory\n')
  })
})
