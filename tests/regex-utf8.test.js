import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Every grep and sed answer here was recorded from GNU grep 3.11 and GNU sed
// 4.9 in the C.UTF-8 locale, the locale this terminal reads a regular
// expression in: a `.`, and a bracket of ASCII members, take one character,
// accented or not, and the classes, words and case come from glibc's own
// tables (tests/fixtures/conformance/utf8.tests has the rest). The awk
// answers follow gawk, which reads the same tables through the same matchers.
const FILES = {
  'src/template.js': 'export default 1\n',
  'src/app.js': "import layout from './template.js'\n",
  'docs/guide.md': 'Use template.js for the layout — voilà, café.\n',
  'README.md': 'naïve\n',
  dot: 'aéb\n', cafe: 'café\n', one: 'é\n', unicode: 'oak\nOAK\né\n', sp: 'é \n', sel: 'é😀z\n', ve: '\u1C80\n',
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
    it(line, async () => assert.deepEqual(await run(line), expected(stdout, exitCode)))
  }
})

describe('awk reads the same tables: classes, words, spaces and IGNORECASE', () => {
  for (const [program, stdout] of [
    ['BEGIN {print "é" ~ /\\w/, "é" ~ /\\W/, "é" ~ /\\y/, "日" ~ /\\w/, "É" ~ /[[:upper:]]/, "é" ~ /[[:upper:]]/, "日" ~ /[[:alpha:]]/}', '1 0 1 1 1 0 1\n'],
    ['BEGIN {print match("aéb", /\\w+/), RLENGTH, split("a\u2003b", p, /\\s/), "a\u00A0b" ~ /\\s/, "\u2003" ~ /[[:space:]]/}', '1 3 2 0 1\n'],
    // The dotted I and the Kelvin sign are their own upper case, so `i` and
    // `k` do not stand for them; the final sigma and the long s fold one way.
    ['BEGIN {IGNORECASE = 1; print "ı" ~ /i/, "İ" ~ /i/, "\u212A" ~ /k/, "ſ" ~ /s/, "ς" ~ /Σ/, "ı" ~ "i"}', '1 0 0 1 1 1\n'],
    // A range runs between its endpoints\' upper cases, over the text\'s.
    ['BEGIN {IGNORECASE = 1; print "x" ~ /[[:upper:]]/, "_" ~ /[A-z]/, "_" ~ /[a-{]/, "a" ~ /[[-{]/, "ſ" ~ /[!-~]/}', '1 0 1 0 1\n'],
    ['BEGIN {IGNORECASE = 1; s = "Σςσ"; n = gsub(/σ/, "X", s); print n, s, toupper("x")}', '3 XXX X\n'],
    ['BEGIN {IGNORECASE = 1; print "É" ~ /[[:lower:]]/, "é" ~ /[^é]/, match("CAFÉ", /é/), RLENGTH}', '1 0 4 1\n'],
  ]) {
    it(program, async () => assert.deepEqual(await createTerminal({}).run(`awk '${program}'`), expected(stdout)))
  }
})

describe('what still needs more than the tables is refused', () => {
  for (const [line, command, detail] of [
    // PCRE reads case and classes by its own tables.
    ['grep -Pi é one', 'grep', 'non-ASCII regex semantics'],
    [String.raw`grep -P '\w' one`, 'grep', 'non-ASCII regex semantics'],
    // A backreference under -i keeps the JS case flag, which agrees with GNU
    // over ASCII alone.
    [String.raw`grep -i '\(é\)\1' one`, 'grep', 'non-ASCII regex semantics'],
    [String.raw`grep -iE '(a)\1' one`, 'grep', 'non-ASCII regex semantics'],
    // GNU's two matchers fold the Cyrillic Extended-C letters differently.
    ['grep -i в ve', 'grep', 'locale-sensitive regex'],
    ['grep -i \u1C80 one', 'grep', 'locale-sensitive regex'],
    ["sed 's/в/X/I' ve", 'sed', 'case folding of Cyrillic Extended-C letters'],
    [`awk 'BEGIN {IGNORECASE = 1; print "\u1C80" ~ /в/}'`, 'awk', 'locale-sensitive regex'],
    // ripgrep matches Unicode the same way everywhere, and that engine is not modelled.
    ['rg . one', 'rg', 'non-ASCII matching'],
  ]) {
    it(line, async () => {
      const r = await run(line)
      assert.equal(r.stdout, '', line)
      assert.notEqual(r.exitCode, 0, line)
      assert.deepEqual(r.unsupported.map((u) => [u.command, u.detail]), [[command, detail]], line)
    })
  }
})
