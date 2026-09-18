import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Every answer here was recorded from GNU grep 3.11 and GNU sed 4.9 in the
// C.UTF-8 locale, the locale this terminal reads a regular expression in: a
// `.`, and a bracket of ASCII members, take one character, accented or not.
const FILES = {
  'src/template.js': 'export default 1\n',
  'src/app.js': "import layout from './template.js'\n",
  'docs/guide.md': 'Use template.js for the layout — voilà, café.\n',
  'README.md': 'naïve\n',
  dot: 'aéb\n', cafe: 'café\n', one: 'é\n', unicode: 'oak\nOAK\né\n', sp: 'é \n', sel: 'é😀z\n',
}
const expected = (stdout, exitCode = 0) => ({ stdout, stderr: '', exitCode, cwd: '/', notes: [], unsupported: [] })
const run = (line) => createTerminal(FILES).run(line)

describe('a dot reads one character over non-ASCII text, as it does in C.UTF-8', () => {
  for (const [line, stdout, exitCode = 0] of [
    ["grep -rln 'template.js' .", './docs/guide.md\n./src/app.js\n'],
    ["grep -c 'a.b' dot", '1\n'],
    ["grep -o 'a.b' dot", 'aéb\n'],
    ["grep -o '[^a-z]' cafe", 'é\n'],
    ["grep -c '^.\\{4\\}$' cafe", '1\n'],
    ['grep -x . one', 'é\n'],
    ['grep -n . unicode', '1:oak\n2:OAK\n3:é\n'],
    ["grep -oE '.+.+ ' sp", '', 1],
    ["grep -cE 'x|a.' dot", '1\n'],
    ["sed 's/./x/' one", 'x\n'],
    ["sed -n '/^.$/p' one", 'é\n'],
    ["sed 's/./X/2' sel", 'éXz\n'],
  ]) {
    it(line, () => assert.deepEqual(run(line), expected(stdout, exitCode)))
  }
})

describe('what still needs the locale tables is refused over non-ASCII input', () => {
  for (const [line, command, detail] of [
    ['grep -i é one', 'grep', 'non-ASCII regex semantics'],
    ['grep -w a dot', 'grep', 'non-ASCII regex semantics'],
    [String.raw`grep '\w' one`, 'grep', 'non-ASCII regex semantics'],
    ["grep '[[:alpha:]]' one", 'grep', 'non-ASCII regex semantics'],
    // A non-ASCII literal beside a bracket, a dot or a repetition waits too.
    ["grep -c '[^é]' one", 'grep', 'non-ASCII regex semantics'],
    ["grep -cE 'é{2}' one", 'grep', 'non-ASCII regex semantics'],
    ["sed 's/[[:alpha:]]/x/' one", 'sed', 'non-ASCII regex semantics'],
    // ripgrep matches Unicode the same way everywhere, and that engine is not modelled.
    ['rg . one', 'rg', 'non-ASCII matching'],
  ]) {
    it(line, () => {
      const r = run(line)
      assert.equal(r.stdout, '', line)
      assert.notEqual(r.exitCode, 0, line)
      assert.deepEqual(r.unsupported.map((u) => [u.command, u.detail]), [[command, detail]], line)
    })
  }
})
