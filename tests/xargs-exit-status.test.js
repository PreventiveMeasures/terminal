import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const PREFIXES = ['', '/bin/', '/usr/bin/']
const MODES = ['-n1', '-I{}']
const INPUTS = {
  cd: '/dest\n/other\n/start\n',
  exit: '0\n1\n2\n',
  export: 'AUDIT=changed\nAUDIT=again\nAUDIT=last\n',
}
const ITEMS = 'first\nsecond\nthird\n'
const ALL_CALLS = [['first'], ['second'], ['third']]

function invocation(mode, command) {
  return 'xargs ' + mode + ' ' + command + (mode === '-I{}' ? ' {}' : '') + ' < /items'
}

function terminal(input, commands) {
  return createTerminal({
    items: input,
    'start/keep': '',
    'dest/keep': '',
    'other/keep': '',
  }, { cwd: '/start', commands })
}

function builtinGap(command) {
  return {
    kind: 'command', command, detail: command,
    message: command + ': shell builtin cannot be invoked as an external command',
  }
}

function assertUnchanged(term) {
  assert.deepEqual(term.run('echo "$AUDIT"; echo alive'), {
    stdout: 'original\nalive\n', stderr: '', exitCode: 0, cwd: '/start', notes: [], unsupported: [],
  })
}

describe('xargs — unavailable external command exit statuses', () => {
  for (const [name, input] of Object.entries(INPUTS)) {
    for (const prefix of PREFIXES) {
      const command = prefix + name
      it(command + ' exits 127 and stops after the first unavailable batch', () => {
        for (const mode of MODES) {
          const gap = builtinGap(command)
          const direct = terminal(input)
          direct.run('AUDIT=original')
          assert.deepEqual(direct.run(invocation(mode, command)), {
            stdout: '', stderr: gap.message + '\n', exitCode: 127, cwd: '/start', notes: [], unsupported: [gap],
          }, mode)
          assertUnchanged(direct)

          const hidden = terminal(input)
          hidden.run('AUDIT=original')
          assert.deepEqual(hidden.run(invocation(mode, command) + ' 2>/dev/null | cat'), {
            stdout: '', stderr: '', exitCode: 0, cwd: '/start', notes: [], unsupported: [gap],
          }, mode + ': suppressing stderr must preserve the diagnostic')
          assertUnchanged(hidden)
        }
      })
    }
  }

  for (const mode of MODES) {
    it(mode + ' stops immediately when a command is not registered', () => {
      const result = terminal(ITEMS).run(invocation(mode, 'agent-missing-tool'))
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 127)
      assert.equal(result.cwd, '/start')
      assert.equal(result.stderr.split('\n').length, 2, 'only the first batch may report a missing command')
      assert.match(result.stderr, /^agent-missing-tool: command not found\. Available: [^\n]+\n$/u)
      assert.deepEqual(result.unsupported.map(({ kind, command, detail }) => ({ kind, command, detail })), [
        { kind: 'command', command: 'agent-missing-tool', detail: 'agent-missing-tool' },
      ])
      assert.equal(result.unsupported[0].message + '\n', result.stderr)
    })
  }
})

describe('xargs — registered commands returning unsuccessful statuses', () => {
  for (const prefix of PREFIXES) {
    for (const mode of MODES) {
      const command = prefix + 'worker'
      it(mode + ' ' + command + ' maps a registered handler status 127 to 123 and continues', () => {
        const calls = []
        const term = terminal(ITEMS, {
          worker: (io) => {
            calls.push([...io.args])
            return { stdout: io.args.join(' ') + '\n', stderr: 'worker: deliberate failure\n', exitCode: 127 }
          },
        })
        assert.deepEqual(term.run(invocation(mode, command)), {
          stdout: ITEMS,
          stderr: 'worker: deliberate failure\nworker: deliberate failure\nworker: deliberate failure\n',
          exitCode: 123, cwd: '/start', notes: [], unsupported: [],
        })
        assert.deepEqual(calls, ALL_CALLS)
      })
    }
  }

  for (const mode of MODES) {
    it(mode + ' maps false to 123 without an unsupported diagnostic', () => {
      assert.deepEqual(terminal(ITEMS).run(invocation(mode, 'false')), {
        stdout: '', stderr: '', exitCode: 123, cwd: '/start', notes: [], unsupported: [],
      })
    })

    it(mode + ' maps status 255 to 124 and stops before the second batch', () => {
      const calls = []
      const term = terminal(ITEMS, {
        worker: (io) => {
          calls.push([...io.args])
          return { stdout: io.args.join(' ') + '\n', stderr: 'worker: stop\n', exitCode: 255 }
        },
      })
      assert.deepEqual(term.run(invocation(mode, '/usr/bin/worker')), {
        stdout: 'first\n',
        stderr: 'worker: stop\nxargs: /usr/bin/worker: exited with status 255; aborting\n',
        exitCode: 124, cwd: '/start', notes: [], unsupported: [],
      })
      assert.deepEqual(calls, [['first']])
    })
  }
})
