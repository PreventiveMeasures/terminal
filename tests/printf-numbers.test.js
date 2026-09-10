import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

describe('printf floating-point representation boundaries', () => {
  const supported = [
    ["printf '%f' 0.1", '0.100000'],
    ["printf '%.2f %.2e %.5g' 123.456 123.456 123.456", '123.46 1.23e+02 123.46'],
    ["printf '%g %f' 1e-300 1e-300", '1e-300 0.000000'],
    ["printf '%.20f' 1.5", '1.50000000000000000000'],
    ["printf '%.20f' 0x1.8p0", '1.50000000000000000000'],
    ["printf '%.0f' 0x1p60", '1152921504606846976'],
    ["printf '%f' 0x0.8", '0.500000'],
    ["printf '%f' 0x100000000000001p-56", '1.000000'],
    ["printf '%f' 0x0p9999999999999999999999999", '0.000000'],
    ["printf '%g' 0x1" + '0'.repeat(300) + 'p-1200', '1'],
    ["printf '%g' 0x0." + '0'.repeat(300) + '8p1204', '8'],
  ]
  for (const [command, stdout] of supported) {
    it(command, () => {
      assert.deepEqual(createTerminal({}).run(command), {
        stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
      })
    })
  }

  const unsupported = [
    ["printf '%.0f' 9007199254740993", 'floating-point precision'],
    ["printf '%.17g' 9007199254740993", 'floating-point precision'],
    ["printf '%.0f' 0x20000000000001", 'floating-point precision'],
    ["printf '%.20f' 0.1", 'floating-point precision'],
    ["printf '%.2f' 2.675", 'floating-point precision'],
    ["printf '%.18f' 0x100000000000001p-56", 'floating-point precision'],
    ["printf '%.100f' 0x1p-101", 'floating-point precision'],
    ["printf '%g' 1e400", 'floating-point range'],
    ["printf '%g' 1e-400", 'floating-point range'],
    ["printf '%g' 0x1p2000", 'floating-point range'],
    ["printf '%g' 0x0.ep-2000", 'floating-point range'],
  ]
  for (const [command, detail] of unsupported) {
    it(command + ' reports precision loss through redirected stderr', () => {
      const terminal = createTerminal({})
      const plain = terminal.run(command)
      assert.equal(plain.stdout, '')
      assert.notEqual(plain.exitCode, 0)
      assert.equal(plain.unsupported.length, 1)
      assert.equal(plain.unsupported[0].detail, detail)
      const hidden = terminal.run(command + ' 2>/dev/null | cat')
      assert.deepEqual(hidden, {
        stdout: '', stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: plain.unsupported,
      })
    })
  }
})

describe('printf missing and empty numeric operands', () => {
  it('fills missing numeric operands with zero without reporting an error', () => {
    assert.deepEqual(createTerminal({}).run("printf '%d %u %f'"), {
      stdout: '0 0 0.000000', stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
    })
  })

  it('reports explicit empty numeric operands as ordinary conversion errors', () => {
    assert.deepEqual(createTerminal({}).run("printf '%d %f' '' ''"), {
      stdout: '0 0.000000', stderr: 'printf: : invalid number\nprintf: : invalid number\n',
      exitCode: 1, cwd: '/', notes: [], unsupported: [],
    })
  })
})
