import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// The writable overlay: mounted sources stay read-only and `/tmp` is the
// only place a command may write, so a workflow copies its fixtures there
// with `cp` first. The editing cases are the BusyBox sed behaviours that
// need somewhere to write, held back from upstream-busybox-grep-sed.test.js
// because of it; their expectations are GNU sed 4.9's output for the same
// command line. The refusal cases pin the boundary itself — off `/tmp` the
// same commands must fail visibly rather than quietly succeed.

const TREES = { input: 'oak\nelm\nfir\n' }
const NUMS = { input: '1\n2\n3\n4\n5\n' }

// [name, files, command, stdout, exitCode]
const WRITES = [
  ['-i rewrites the file', TREES, 'sed -i s/oak/pine/ input; cat input', 'pine\nelm\nfir\n'],
  ['-i reports success', TREES, 'sed -i s/oak/pine/ input; echo $?', '0\n'],
  ['-i with an address', TREES, "sed -i -e '1s/oak/pine/' input; cat input", 'pine\nelm\nfir\n'],
  ['-i deletes a range', NUMS, "sed '1,2d' -i input; echo $?; cat input", '0\n3\n4\n5\n'],
  ['-i over several files', TREES, "cp input other; sed -i -e '1s/oak/pine/' input other; cat input other", 'pine\nelm\nfir\npine\nelm\nfir\n'],
  ['-i with a relative range over several files', NUMS, "cp input other; sed '/^4/,+0d' -i input other; echo $?; cat input other", '0\n1\n2\n3\n5\n1\n2\n3\n5\n'],
  ['-i appends after the last line', TREES, "sed -e '$a pine' -i input; cat input", 'oak\nelm\nfir\npine\n'],
  ['-i leaves an unmatched file alone', TREES, 'sed -i s/pine/oak/ input; cat input', 'oak\nelm\nfir\n'],
  ['the w flag writes matches to a file', TREES, "sed 's/oak/pine/w out' input; cat out", 'pine\nelm\nfir\npine\n'],
  ['the w flag with -n', TREES, "sed -n 's/oak/pine/w out' input; cat out", 'pine\n'],
  ['the w command writes whole lines', TREES, "sed -n '/elm/w out' input; cat out", 'elm\n'],
  ['two w commands share one file', TREES, "sed -n -e '/oak/w out' -e '/fir/w out' input; cat out", 'oak\nfir\n'],
  ['w truncates the file once per run', TREES, "sed -n '/oak/w out' input; sed -n '/fir/w out' input; cat out", 'fir\n'],
  ['a redirect creates a file', TREES, 'sed s/oak/pine/ input > out; cat out', 'pine\nelm\nfir\n'],
  ['an appending redirect', TREES, 'sed -n 1p input > out; sed -n 2p input >> out; cat out', 'oak\nelm\n'],
  ['a copy is edited, not the source', TREES, 'cp input copy; sed -i s/oak/pine/ copy; cat copy input', 'pine\nelm\nfir\noak\nelm\nfir\n'],
]

// Sources are mounted away from /tmp, which is the writable overlay.
const overlay = (files) => createTerminal(files, { mount: '/work', cwd: '/work', writable: '/tmp/' })

function inOverlay(files, command) {
  const terminal = overlay(files)
  for (const name of Object.keys(files)) {
    assert.deepEqual(terminal.run(`cp ${name} /tmp/${name}`).unsupported, [], `copying ${name} into the overlay`)
  }
  assert.equal(terminal.run('cd /tmp').exitCode, 0)
  return terminal.run(command)
}

describe('writable overlay — editing commands that need somewhere to write', () => {
  for (const [name, files, command, stdout, exitCode = 0] of WRITES) {
    it(name, () => {
      const result = inOverlay(files, command)
      assert.deepEqual(result.unsupported, [], name + ': the overlay must not refuse a write it allows')
      assert.deepEqual({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
        { stdout, stderr: '', exitCode })
    })
  }
})

describe('writable overlay — the mounted sources stay read-only', () => {
  // The same commands, run where they are not allowed to write. Each must
  // report the gap on the diagnostic feed instead of half-applying an edit.
  const REFUSED = [
    ['sed -i', 'sed -i s/oak/pine/ input', '-i'],
    ['the s/// write flag', "sed 's/oak/pine/w out' input", 'output file'],
    ['the w command', "sed -n '/elm/w out' input", 'output file'],
    ['a truncating redirect', 'sed s/oak/pine/ input > out', '>'],
    ['an appending redirect', 'sed s/oak/pine/ input >> out', '>>'],
    ['a stderr redirect', 'sed s/oak/pine/ input 2> err', '2>'],
  ]
  for (const [name, command, detail] of REFUSED) {
    it(name + ' is refused outside /tmp', () => {
      const terminal = createTerminal(TREES)
      const result = terminal.run(command)
      assert.notEqual(result.exitCode, 0, command + ': a refused write must not report success')
      assert.equal(result.unsupported.length, 1, command + ': the refusal must reach the diagnostic feed')
      assert.equal(result.unsupported[0].detail, detail)
      // A command names itself in its message; the shell prefixes 'error: '.
      assert.ok(result.stderr.trimEnd().endsWith(result.unsupported[0].message),
        command + ': stderr must carry the diagnostic message')
      assert.equal(terminal.run('cat input').stdout, TREES.input, command + ': the source must be untouched')
    })
  }

  it('refuses a write aimed outside /tmp even with the overlay mounted', () => {
    const terminal = overlay(TREES)
    const result = terminal.run('sed s/oak/pine/ input > /work/out')
    assert.notEqual(result.exitCode, 0)
    assert.equal(result.unsupported.length, 1)
    assert.equal(result.unsupported[0].detail, '>')
  })

  it('keeps the overlay out of the mounted listing', () => {
    const terminal = overlay(TREES)
    assert.equal(terminal.run('echo made > /tmp/out').exitCode, 0)
    assert.equal(terminal.run('ls').stdout, 'input\n')
    assert.equal(terminal.run('cat /tmp/out').stdout, 'made\n')
  })
})

describe('writable overlay — configuration', () => {
  it("accepts only '/tmp/' as the writable root", () => {
    assert.throws(() => createTerminal(TREES, { writable: '/work/' }), TypeError)
    assert.throws(() => createTerminal(TREES, { writable: true }), TypeError)
  })

  it('refuses a mount that would overlap the overlay', () => {
    assert.throws(() => createTerminal(TREES, { writable: '/tmp/' }), /mount must not be/u)
    assert.throws(() => createTerminal(TREES, { mount: '/tmp/x', writable: '/tmp/' }), /mount must not be/u)
  })

  it('leaves the filesystem read-only when the option is absent', () => {
    const result = createTerminal(NUMS).run('sed -i 1d input')
    assert.equal(result.unsupported.length, 1)
    assert.equal(createTerminal(NUMS).run('cat input').stdout, NUMS.input)
    assert.notEqual(result.exitCode, 0)
  })
})
