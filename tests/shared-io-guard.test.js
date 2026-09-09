import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { mountSources } from '../src/mount.js'
import { createIoGuard } from '../src/shell/io.js'
import { routeOutput } from '../src/shell/output.js'
import { unsupportedNote } from '../src/unsupported.js'

const options = { mount: '/repo', writable: '/tmp/' }
const expected = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] })

function setup() {
  const { fs } = mountSources({}, options)
  const io = createIoGuard(fs)
  const handle = fs.openWritable('/', '/tmp/input', true)
  handle.write('original\n')
  return { fs, io, handle }
}

describe('filesystem mutation guards apply to future reader implementations', () => {
  for (const [name, write] of [
    ['inherited handle', ({ handle }) => handle.write('changed')],
    ['new append handle', ({ fs }) => fs.openWritable('/', '/tmp/input', true).write('changed')],
    ['aliased append handle', ({ fs }) => fs.openWritable('/', '/tmp/./input', true).write('changed')],
    ['truncate', ({ fs }) => fs.openWritable('/', '/tmp/input')],
  ]) {
    for (const nested of [false, true]) {
      it(`${name}, nested=${nested}`, () => {
        const state = setup()
        assert.throws(() => state.io.run('future-reader', () => {
          state.fs.readFile('/tmp/input')
          return nested ? state.io.run('future-writer', () => write(state)) : write(state)
        }), (error) => {
          assert.deepEqual([unsupportedNote(error).command, unsupportedNote(error).detail], ['future-reader', 'streaming self-output'])
          return true
        })
        assert.equal(state.fs.readFile('/tmp/input'), 'original\n')
        state.handle.write('after\n')
        assert.equal(state.fs.readFile('/tmp/input'), 'original\nafter\n')
      })
    }
  }

  it('keeps a returned result protected until its destination is written', () => {
    const { fs, io, handle } = setup()
    assert.throws(() => io.run('future-reader', () => {
      const stdout = fs.readFile('/tmp/input')
      return routeOutput({ stdout, stderr: '', exitCode: 0 }, { fds: { 1: handle, 2: 'err' } }, { io })
    }), /actively read input/u)
    assert.equal(fs.readFile('/tmp/input'), 'original\n')
  })

  it('allows opening for append without writing', () => {
    const { fs, io } = setup()
    io.run('future-reader', () => {
      fs.readFile('/tmp/input')
      fs.openWritable('/', '/tmp/input', true).write('')
    })
    assert.equal(fs.readFile('/tmp/input'), 'original\n')
  })

  it('releases a completed child reader before a later child writer', () => {
    const { fs, io, handle } = setup()
    io.run('future-parent', () => {
      io.run('future-reader', () => fs.readFile('/tmp/input'))
      io.run('future-writer', () => handle.write('later\n'))
    })
    assert.equal(fs.readFile('/tmp/input'), 'original\nlater\n')
  })

  it('preserves ancestors when a child fully buffers its own input', () => {
    const { fs, io, handle } = setup()
    assert.throws(() => io.run('future-reader', () => {
      fs.readFile('/tmp/input')
      io.run('future-buffered-child', () => {
        io.bufferOutput()
        return routeOutput({ stdout: 'changed', stderr: '', exitCode: 0 }, { fds: { 1: handle, 2: 'err' } }, { io })
      })
    }), /actively read input/u)
    assert.equal(fs.readFile('/tmp/input'), 'original\n')
  })

  it('buffering metadata reads cannot hide an already active reader', () => {
    const { fs, io, handle } = setup()
    assert.throws(() => io.run('future-reader', () => {
      fs.readFile('/tmp/input')
      io.bufferReads(() => handle.write('changed'))
    }), /actively read input/u)
    assert.equal(fs.readFile('/tmp/input'), 'original\n')
  })
})

describe('new writers and renamed inodes cannot bypass live-reader protection', () => {
  for (const command of [
    "xargs -I{} sed 's/x/y/w /tmp/args' '{}' </tmp/args",
    "xargs -I{} xargs sed 's/x/y/w /tmp/args' '{}' </tmp/args",
    "xargs -I{} sed -e 's/x/y/w /tmp/./args' '{}' </tmp/args",
  ]) {
    it(command, () => {
      const terminal = createTerminal({ source: 'x\n' }, options)
      assert.deepEqual(terminal.run("printf '/repo/source\\n' >/tmp/args"), expected())
      const result = terminal.run(command + ' 2>/dev/null | cat')
      assert.equal(result.exitCode, 0)
      assert.ok(result.unsupported.some(({ detail }) => detail === 'streaming self-output'), JSON.stringify(result))
      assert.deepEqual(terminal.run('cat /tmp/args'), expected('/repo/source\n'))
    })
  }

  it('blocks a backup alias that still owns a read inode', () => {
    const { fs, io, handle } = setup()
    assert.throws(() => io.run('future-reader', () => {
      fs.readFile('/tmp/input')
      fs.replaceWritable('/', '/tmp/input', 'replacement\n', '/tmp/backup')
      fs.openWritable('/', '/tmp/backup', true).write('changed')
    }), /actively read input/u)
    assert.equal(fs.readFile('/tmp/backup'), 'original\n')
    assert.equal(fs.readFile('/tmp/input'), 'replacement\n')
    handle.write('after\n')
    assert.equal(fs.readFile('/tmp/backup'), 'original\nafter\n')
  })

  it('allows a fresh inode at a formerly read pathname', () => {
    const { fs, io } = setup()
    io.run('future-reader', () => {
      fs.readFile('/tmp/input')
      fs.removeWritable('/', '/tmp/input')
      fs.openWritable('/', '/tmp/input', true).write('replacement\n')
    })
    assert.equal(fs.readFile('/tmp/input'), 'replacement\n')
  })
})

describe('combined output ordering follows file identity after replacement', () => {
  const commands = { mixed: () => ({ stdout: 'out\n', stderr: 'err\n' }) }

  it('keeps independent inodes separate even when their handles have the same pathname', () => {
    const terminal = createTerminal({}, { ...options, commands })
    const result = terminal.run("printf old >/tmp/log; { sed -i.bak 's/o/O/' /tmp/log; mixed 2>/tmp/log; } >>/tmp/log")
    assert.deepEqual(result, expected())
    assert.deepEqual(terminal.run('cat /tmp/log.bak'), expected('oldout\n'))
    assert.deepEqual(terminal.run('cat /tmp/log'), expected('err\n'))
  })

  it('recognizes merged inodes reached through different backup names', () => {
    const terminal = createTerminal({}, { ...options, commands })
    const result = terminal.run("printf old >/tmp/log; { sed -i.bak 's/o/O/' /tmp/log; mixed 2>>/tmp/log.bak; } >>/tmp/log")
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['combined output ordering'])
    assert.deepEqual(terminal.run('cat /tmp/log'), expected('Old'))
    assert.match(terminal.run('cat /tmp/log.bak').stdout, /^olderror: merging/u)
  })
})
