import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Backticks and double quotes are shell-escaped; \S and \s reach GNU ERE
// unchanged. The slash after the quote class is a literal match character.
// https://www.gnu.org/software/grep/manual/html_node/Special-Backslash-Expressions.html
const command = String.raw`grep -vE "=>|function|async|,$|^\S+-[0-9]+-\s*['\`\"]/"`
const result = (stdout, exitCode = 0) => ({ stdout, stderr: '', exitCode, cwd: '/', notes: [], unsupported: [] })
const excluded = [
  'const arrow = () => value',
  'function run() {}',
  'const asynchronous = true',
  'property: value,',
  "src/file.js-12-'/route'",
  'src/file.js-12-`/route`',
  'src/file.js-12-"/route"',
  'src/file-name.ts-123-  "/route"',
  "src/file.js-0-\t'/route'",
  'src/file.js-4-\r\f\v"/route"',
]
const retained = [
  'const plain = 1',
  'const ASYNC = FUNCTION',
  'property: value, ',
  'src/file.js-12-"relative/route"',
  'src/file.js-12- /route',
  'src/file.js-12-" /route"',
  'src/file.js:12:"/route"',
  'src/file.js-x-"/route"',
  'src/file.js--"/route"',
  'src/file.js-12.3-"/route"',
  'src/file.js-12-\\/route',
  ' src/file.js-12-"/route"',
  'src/file name.js-12-"/route"',
  '-12-"/route"',
  '',
]
const input = [...excluded, ...retained].join('\n') + '\n'
const expected = retained.join('\n') + '\n'

describe('grep quoted context-line filter from agent logs', () => {
  for (const shell of [
    `cat input | ${command}`,
    `${command} <input`,
    `${command} input`,
    `cat input | ${command} 2>/dev/null | cat`,
  ]) {
    it(shell, () => assert.deepEqual(createTerminal({ input }).run(shell), result(expected)))
  }

  for (const line of excluded) {
    it(`filters ${JSON.stringify(line)} with status 1 when nothing remains`, () => {
      assert.deepEqual(createTerminal({ input: line + '\n' }).run(`${command} input`), result('', 1))
    })
  }

  it('handles empty input without quote or unsupported errors', () => {
    assert.deepEqual(createTerminal({ input: '' }).run(`${command} input`), result('', 1))
    assert.deepEqual(createTerminal({}).run(command), result('', 1))
  })

  it('keeps a final retained line without a newline and supplies grep output termination', () => {
    assert.deepEqual(createTerminal({ input: 'keep this' }).run(`${command} input`), result('keep this\n'))
  })

  it('keeps locale-sensitive Unicode whitespace visible in diagnostics', () => {
    const actual = createTerminal({ input: 'src/file.js-12-\u2003"/route"\n' }).run(`${command} input 2>/dev/null | cat`)
    assert.equal(actual.stdout, '')
    assert.equal(actual.stderr, '')
    assert.equal(actual.exitCode, 0)
    assert.deepEqual(actual.unsupported.map((entry) => ({ command: entry.command, detail: entry.detail })), [
      { command: 'grep', detail: 'non-ASCII regex semantics' },
    ])
  })
})
