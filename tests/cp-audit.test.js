import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { quoteName } from '../src/commands/quote-name.js'

// GNU copy.c emit_verbose uses buffered stdio; error() and stream closure
// can flush that output after copying has already changed an aliased file.
// https://github.com/coreutils/coreutils/blob/v9.11/src/copy.c
const makeTerminal = () => createTerminal({ a: 'alpha', b: 'beta', 'dir/file': 'nested' }, { mount: '/repo', writable: '/tmp/', cwd: '/repo' })
const expected = (stdout = '', stderr = '', exitCode = 0) => ({ stdout, stderr, exitCode, cwd: '/repo', notes: [], unsupported: [] })

describe('cp does not invent a verbose-output buffering order', () => {
  for (const operator of ['>', '>>']) {
    for (const [command, modified, content] of [
      ['cp -v /tmp/source /tmp/destination', '/tmp/source', 'source'],
      ['cp -v /tmp/source /tmp/destination', '/tmp/destination', 'destination'],
      ['cp -v /tmp/./source /tmp/destination', '/tmp/source', 'source'],
      ['cp -v a /tmp/./destination', '/tmp/destination', 'destination'],
    ]) {
      it(`${command} ${operator}${modified}`, () => {
        const terminal = makeTerminal()
        assert.deepEqual(terminal.run('printf source >/tmp/source; printf destination >/tmp/destination'), expected())
        const result = terminal.run(`${command} ${operator}${modified} 2>/dev/null`)
        assert.equal(result.exitCode, 1)
        assert.equal(result.stdout, '')
        assert.equal(result.stderr, '')
        assert.deepEqual(result.unsupported.map(({ command: name, detail }) => [name, detail]), [['cp', 'copy output buffering']])
        assert.deepEqual(terminal.run(`cat ${modified}`), expected(operator === '>' ? '' : content))
      })
    }
  }

  it('detects a later operand before the first verbose line changes its contents', () => {
    const terminal = makeTerminal()
    terminal.run('printf later >/tmp/later')
    const result = terminal.run('cp -v a missing /tmp/later /tmp >>/tmp/later 2>/dev/null | cat')
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['copy output buffering'])
    assert.deepEqual(terminal.run('cat /tmp/later'), expected('later'))
    assert.deepEqual(terminal.run('test -e /tmp/a'), expected('', '', 1))
  })

  it('detects an open stdout inode subsequently moved to a backup path', () => {
    const terminal = makeTerminal()
    terminal.run('printf source >/tmp/source')
    const result = terminal.run("{ sed -i.bak s/source/replaced/ /tmp/source; cp -v /tmp/source.bak /tmp/copy; } >>/tmp/source 2>/dev/null")
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['copy output buffering'])
    assert.deepEqual(terminal.run('cat /tmp/source /tmp/source.bak'), expected('replacedsource'))
    assert.deepEqual(terminal.run('test -e /tmp/copy'), expected('', '', 1))
  })

  it('allows a replaced path whose current inode is independent of stdout', () => {
    const terminal = makeTerminal()
    terminal.run('printf source >/tmp/source')
    assert.deepEqual(terminal.run("{ sed -i s/source/replaced/ /tmp/source; cp -v /tmp/source /tmp/copy; } >>/tmp/source"), expected())
    assert.deepEqual(terminal.run('cat /tmp/source /tmp/copy'), expected('replacedreplaced'))
  })

  it('keeps separate logs and merged ordinary errors in command order', () => {
    const terminal = makeTerminal()
    assert.deepEqual(terminal.run('cp -v a missing b /tmp >/tmp/log 2>&1'), expected('', '', 1))
    assert.deepEqual(terminal.run('cat /tmp/log'), expected("'a' -> '/tmp/a'\ncp: cannot stat 'missing': No such file or directory\n'b' -> '/tmp/b'\n"))
    assert.deepEqual(terminal.run('cat /tmp/a /tmp/b'), expected('alphabeta'))
  })

  for (const output of ['/tmp/source', '/tmp/destination']) {
    it(`allows ordinary copying with unused stdout redirected to ${output}`, () => {
      const terminal = makeTerminal()
      terminal.run('printf source >/tmp/source')
      assert.deepEqual(terminal.run(`cp /tmp/source /tmp/destination >>${output}`), expected())
      assert.deepEqual(terminal.run('cat /tmp/source /tmp/destination'), expected('sourcesource'))
    })
  }

  for (const target of ['/dev/stdout', '/dev/./stdout', '//dev//stdout']) {
    it(`retains the special-file diagnostic for ${target}`, () => {
      const result = makeTerminal().run(`cp -v a ${target} 2>/dev/null | cat`)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['special file'])
    })
  }

  it('does not diagnose no-clobber when no verbose output is emitted', () => {
    const terminal = makeTerminal()
    terminal.run('printf original >/tmp/out')
    assert.deepEqual(terminal.run('cp -nv a /tmp/out >>/tmp/out'), expected())
    assert.deepEqual(terminal.run('cp -nv /tmp/out /tmp/out >>/tmp/out'), expected())
    assert.deepEqual(terminal.run('cat /tmp/out'), expected('original'))
  })

  it('finishes the copy and reports a write error for closed verbose stdout', () => {
    const terminal = makeTerminal()
    assert.deepEqual(terminal.run('cp -v a /tmp/b >&-'), expected('', 'cp: write error: Bad file descriptor\n', 1))
    assert.deepEqual(terminal.run('cat /tmp/b'), expected('alpha'))
  })

  it('does not write or fail on closed stdout when no-clobber skips the copy', () => {
    const terminal = makeTerminal()
    terminal.run('printf original >/tmp/b')
    assert.deepEqual(terminal.run('cp -nv a /tmp/b >&-'), expected())
    assert.deepEqual(terminal.run('cat /tmp/b'), expected('original'))
  })

  it('leaves an ordinary same-file error ordinary with unused verbose stdout', () => {
    const terminal = makeTerminal()
    terminal.run('printf original >/tmp/out')
    assert.deepEqual(terminal.run('cp -v /tmp/out /tmp/out >>/tmp/out'), expected('', "cp: '/tmp/out' and '/tmp/out' are the same file\n", 1))
    assert.deepEqual(terminal.run('cat /tmp/out'), expected('original'))
  })
})

describe('cp follows operand and failure ordering', () => {
  for (const command of ['cp -T -t /tmp', 'cp -t /tmp -T', 'cp -T --target-directory=/tmp']) {
    it(command, () => assert.deepEqual(makeTerminal().run(command), expected('', 'cp: missing file operand\n', 1)))
  }

  it('prints the attempted copy before a missing-parent open failure', () => {
    assert.deepEqual(makeTerminal().run('cp -v a /tmp/missing/copy'), expected("'a' -> '/tmp/missing/copy'\n", "cp: cannot create regular file '/tmp/missing/copy': No such file or directory\n", 1))
  })

  for (const target of ['a/../copy', 'a/copy', 'a/']) {
    it(`reports a failed destination stat before verbose output: ${target}`, () => {
      assert.deepEqual(makeTerminal().run('cp -v b ' + target), expected('', `cp: cannot stat '${target}': Not a directory\n`, 1))
    })
  }
})

describe('shared filename quoting retains content and prior command output', () => {
  for (const locale of ['', 'C']) {
    for (const name of ["a\n'b", "'\t'", '\\$`"', 'é😀', 'a\u0001b']) {
      it(`round-trips ${JSON.stringify(name)} in locale ${locale || 'default'}`, () => {
        const quoted = quoteName(name, { vars: new Map([['LC_ALL', locale]]) })
        assert.deepEqual(makeTerminal().run("printf '%s' " + quoted), expected(name))
      })
    }
  }

  it('retains successful rm output when a later filename cannot be quoted', () => {
    const terminal = makeTerminal()
    terminal.run("printf x >/tmp/first; printf y >'/tmp/\u200B'")
    const result = terminal.run("rm -v /tmp/first '/tmp/\u200B'")
    assert.equal(result.stdout, "removed '/tmp/first'\n")
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported.map(({ command, detail }) => [command, detail]), [['rm', 'filename quoting']])
    assert.deepEqual(terminal.run('test -e /tmp/first'), expected('', '', 1))
    assert.deepEqual(terminal.run("cat '/tmp/\u200B'"), expected('y'))
  })

  it('retains earlier errors through suppression of a later unsupported quoting error', () => {
    const terminal = makeTerminal()
    terminal.run("printf x >/tmp/first; printf y >'/tmp/\u200B'")
    const result = terminal.run("rm -v /tmp/missing /tmp/first '/tmp/\u200B' 2>/dev/null | cat")
    assert.equal(result.stdout, "removed '/tmp/first'\n")
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['filename quoting'])
  })
})
