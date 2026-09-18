import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// `set -e` is shell state, the way the working directory and the variables
// are: it outlives the line that set it, and a fork leaves with a copy. What
// it does inside a single line is bash's, and the conformance corpus pins it
// against bash; what follows is what it does between lines and across a fork.
const terminal = () => createTerminal({ input: 'oak\nelm\nfir\n' }, { mount: '/work', cwd: '/work', writable: '/tmp/' })

const answer = (t, line) => {
  const r = t.run(line)
  assert.deepEqual(r.unsupported, [], line)
  return { stdout: r.stdout, exitCode: r.exitCode }
}

describe('set -e — the setting a session keeps', () => {
  it('outlives the line that set it', () => {
    const t = terminal()
    assert.deepEqual(answer(t, 'set -e'), { stdout: '', exitCode: 0 })
    assert.deepEqual(answer(t, 'false; echo after'), { stdout: '', exitCode: 1 })
    assert.deepEqual(answer(t, 'echo still; grep -q zzz input; echo after'), { stdout: 'still\n', exitCode: 1 })
  })

  it('is put back by a later set +e', () => {
    const t = terminal()
    answer(t, 'set -e')
    assert.deepEqual(answer(t, 'set +e'), { stdout: '', exitCode: 0 })
    assert.deepEqual(answer(t, 'false; echo after'), { stdout: 'after\n', exitCode: 0 })
  })

  it('answers with the failing command’s status, and with what ran before it', () => {
    const t = terminal()
    answer(t, 'set -e')
    assert.deepEqual(answer(t, 'echo a; (exit 7); echo b'), { stdout: 'a\n', exitCode: 7 })
  })

  it('stops the lines that follow it in the same call', () => {
    const t = terminal()
    assert.deepEqual(answer(t, 'set -e\necho a\nfalse\necho b'), { stdout: 'a\n', exitCode: 1 })
  })

  it('keeps what the failing command said on stderr', () => {
    const t = terminal()
    const r = t.run('set -e; cat nosuch; echo after')
    assert.deepEqual({ stdout: r.stdout, exitCode: r.exitCode }, { stdout: '', exitCode: 1 })
    assert.match(r.stderr, /cat: nosuch: No such file or directory/u)
    assert.deepEqual(r.unsupported, [])
    assert.deepEqual(r.notes, [])
  })

  it('leaves the directory a halted line had already reached', () => {
    const t = terminal()
    const r = t.run('set -e; cd /tmp; false; cd /')
    assert.equal(r.cwd, '/tmp')
    assert.equal(t.cwd(), '/tmp')
  })
})

describe('set -e — what a fork takes and what it leaves', () => {
  it('copies the parent’s setting', () => {
    const t = terminal()
    answer(t, 'set -e')
    assert.deepEqual(answer(t.fork(), 'false; echo after'), { stdout: '', exitCode: 1 })
  })

  it('starts a session of its own without it', () => {
    const t = terminal()
    answer(t, 'set -e')
    assert.deepEqual(answer(t.fork({ inherit: false }), 'false; echo after'), { stdout: 'after\n', exitCode: 0 })
  })

  it('does not carry a change made after the fork, in either direction', () => {
    const t = terminal()
    const child = t.fork()
    answer(t, 'set -e')
    assert.deepEqual(answer(child, 'false; echo after'), { stdout: 'after\n', exitCode: 0 })
    answer(child, 'set -e')
    answer(child, 'set +e')
    assert.deepEqual(answer(t, 'false; echo after'), { stdout: '', exitCode: 1 })
  })
})

describe('set — the options it will not take', () => {
  // Applying the `-e` of `set -eu` would leave the line running under half of
  // what it asked for, which is a worse answer than none: the whole call is
  // refused, and the feed says so rather than the shell quietly guessing.
  it('refuses a request it could only half honour, and applies none of it', () => {
    const t = terminal()
    const r = t.run('set -eu')
    assert.equal(r.exitCode, 127)
    assert.equal(r.unsupported.length, 1)
    assert.deepEqual({ command: r.unsupported[0].command, kind: r.unsupported[0].kind }, { command: 'set', kind: 'feature' })
    assert.match(r.stderr, /set: `set` is supported only as `set -e` or `set \+e`/u)
    assert.deepEqual(answer(t, 'false; echo after'), { stdout: 'after\n', exitCode: 0 })
  })

  it('takes every spelling of the one option it has', () => {
    for (const line of ['set -e', 'set -o errexit', 'set -e -o errexit', 'set -o errexit -e']) {
      const t = terminal()
      assert.deepEqual(answer(t, line), { stdout: '', exitCode: 0 }, line)
      assert.deepEqual(answer(t, 'false; echo after'), { stdout: '', exitCode: 1 }, line)
    }
    for (const line of ['set +e', 'set +o errexit', 'set -e +e']) {
      const t = terminal()
      answer(t, 'set -e')
      assert.deepEqual(answer(t, line), { stdout: '', exitCode: 0 }, line)
      assert.deepEqual(answer(t, 'false; echo after'), { stdout: 'after\n', exitCode: 0 }, line)
    }
  })

  it('refuses the rest of what set can be asked, naming set', () => {
    for (const line of ['set', 'set -x', 'set -u', 'set -o pipefail', 'set -o', 'set -- a b', 'set --', 'set -e -x', 'set -o noglob']) {
      const r = terminal().run(line)
      assert.deepEqual(r.unsupported.map((note) => note.command), ['set'], line)
      assert.equal(r.exitCode, 127, line)
      assert.equal(r.stdout, '', line)
    }
  })
})
