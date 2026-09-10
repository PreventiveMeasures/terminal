import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const expected = (stdout) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [] })
const continuation = '\\\n'

describe('replacement delimiters use logical characters after continuations', () => {
  // Bash parse_matched_pair removes continuations before parameter_brace_patsub
  // skips an initial literal slash while looking for the replacement delimiter.
  for (const [command, stdout] of [
    ['v=/b/x; printf "%s" "${v//' + continuation + '/b}"', '/x'],
    ['v=/b/x/b; printf "%s" "${v//' + continuation.repeat(3) + '/b}"', '/x'],
    ['v=/b/x/b; printf "%s" "${v//' + continuation + '/b/Y}"', 'Y/xY'],
    ['v=a/b; printf "%s" "${v//' + continuation + '//X}"', 'aXb'],
  ]) {
    it(command, () => assert.deepEqual(createTerminal({}).run(command), expected(stdout)))
  }
})

describe('ambiguous trailing pattern escapes are diagnosed', () => {
  // Bash match_upattern's prefilter differs between anchored and unanchored
  // patterns, and from match_wpattern. A blanket no-match silently corrupts
  // suffix a\ -> aZ, and the composite a\ a* -> Z a*, for a pattern a\.
  for (const [value, pattern, expression] of [
    ['a\\', '\\', '${v/%$p/Z}'],
    ['a\\ a*', 'a\\', '${v/$p/Z}'],
    ['a\\ a*', 'a\\', '${v//$p/Z}'],
    ['\\a', '\\', '${v/#$p/Z}'],
    ['a\\', '\\', '${v/$p/Z}'],
    ['é\\', '\\', '${v/%$p/Z}'],
  ]) {
    it(JSON.stringify({ value, pattern, expression }), () => {
      const terminal = createTerminal({})
      terminal.run(`v='${value}'; p='${pattern}'`)
      const result = terminal.run(`printf '%s' "${expression}"`)
      assert.equal(result.stdout, '')
      assert.notEqual(result.exitCode, 0)
      assert.ok(result.unsupported.some(({ kind, message }) => kind === 'feature' && /trailing.*backslash/u.test(message)), JSON.stringify(result))
    })
  }

  it('preserves the diagnostic with hidden stderr and a successful pipeline', () => {
    const terminal = createTerminal({})
    terminal.run("v='a\\ a*'; p='a\\'")
    const result = terminal.run('{ printf "%s" "${v/$p/Z}"; } 2>/dev/null | true')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.ok(result.unsupported.some(({ kind, message }) => kind === 'feature' && /trailing.*backslash/u.test(message)), JSON.stringify(result))
  })

  for (const command of [
    "v='ba\\'; p='a\\'; printf '%s' \"${v/%\"$p\"/Z}\"",
    "v='ba\\'; p='a\\\\'; printf '%s' \"${v/%$p/Z}\"",
  ]) {
    it('keeps literal escaped-backslash patterns supported: ' + command, () => {
      assert.deepEqual(createTerminal({}).run(command), expected('bZ'))
    })
  }
})
