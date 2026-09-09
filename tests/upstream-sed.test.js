import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Independent cases informed by GNU sed's misc.pl, subst-options.sh,
// subst-replacement.sh, regex-errors.sh, word-delim.sh and posix-mode-addr.sh:
// https://github.com/mirror/sed/tree/0c1fe22ccacf4887e0be6c11deb4e9c83acc287d/testsuite
// The GPL upstream scripts are not vendored or executed by these tests.
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`

function check(script, input, stdout, flags = '') {
  const terminal = createTerminal({ input })
  assert.deepEqual(terminal.run(`sed ${flags} ${quote(script)} input`), {
    stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [],
  })
}

describe('GNU sed audit — substitution and matching', () => {
  const cases = [
    ['empty script preserves input', '', 'oak\n\nelm', 'oak\n\nelm'],
    ['leading blanks preserve empty records', 's/^ *//', '  oak\n\n elm\n', 'oak\n\nelm\n'],
    ['end insertion preserves missing newline', 's/$/:/', 'oak\nelm', 'oak:\nelm:'],
    ['multiple substitutions', 's/-*enable-//;s/=.*//', '--enable-cache=yes\n-enable-log=no\n', 'cache\nlog\n'],
    ['substitution only on last record', '$s/^/last: /', 'oak\nelm', 'oak\nlast: elm'],
    ['whole match in replacement', 's/[0-9][0-9]*/<&>/g', 'oak12elm34\n', 'oak<12>elm<34>\n'],
    ['capture rearrangement', String.raw`s/\([a-z]*\):\([0-9]*\)/\2=\1/`, 'oak:27\n', '27=oak\n'],
    ['unmatched replacement capture is empty', String.raw`s/\(oak\)\?elm/[\1]/`, 'elm\noakelm\n', '[]\n[oak]\n'],
    ['leftmost longest alternative', String.raw`s/\(o\|oak\)/<\1>/`, 'oak\n', '<oak>\n'],
    ['literal opening bracket', 's/[[]/L/g', '[oak[\n', 'LoakL\n'],
    ['literal closing bracket', 's/[]]/R/g', ']oak]\n', 'RoakR\n'],
    ['slash inside a bracket', 's/[/]/:/g', 'oak/elm/fir\n', 'oak:elm:fir\n'],
    ['alternate delimiter', 's#oak/##;s#/[^/]*$##', 'oak/elm/fir\n', 'elm\n'],
    ['BRE literal parentheses', 's/oak()/tree/', 'oak()\n', 'tree\n'],
    ['BRE literal leading star in group', String.raw`s/\(*oak\)/tree/`, '*oak\n', 'tree\n'],
    ['BRE literal leading star after alternative', String.raw`s/oak\|*elm/tree/`, '*elm\n', 'tree\n'],
    ['BRE literal star after a word boundary', String.raw`s/a\b*/X/`, 'a*\na\n', 'X\na\n'],
    ['BRE literal plus after a word boundary', String.raw`s/\b\+/X/`, 'a+\na\n', 'aX\na\n'],
    ['BRE literal question after a word boundary', String.raw`s/\b\?/X/`, 'a?\na\n', 'aX\na\n'],
    ['BRE leading escaped plus is literal', String.raw`s/\+a/X/`, '+a\n', 'X\n'],
    ['BRE repeat of a leading literal star', 's/**/X/', '***\n', 'X\n'],
    ['BRE stacked plus remains valid', String.raw`s/a*\+/X/`, 'aaa\nb\n', 'X\nXb\n'],
    ['ERE stacked stars remain valid', 's/a**/X/', 'aaa\nb\n', 'X\nXb\n', '-E'],
    ['ERE escaped syntax stays literal', String.raw`s/\{z\}/X/;s/\)*/Y/`, '{z}))\n', 'YX))\n', '-E'],
    ['ERE syntax characters inside classes stay literal', 's/[*){}]/X/g', '*){}\n', 'XXXX\n', '-E'],
    ['GNU word boundary', String.raw`s/.\bx//`, '789-x\n', '789\n'],
    ['GNU whitespace escapes', String.raw`s/_\S/XX/g;s/\s/_/g`, '_q\t_r \n', 'XX_XX_\n'],
    ['escaped replacement characters', String.raw`s/oak/\&\\/`, 'oak\n', '&\\\n'],
    ['replacement delimiter', String.raw`s#oak#elm\#fir#`, 'oak\n', 'elm#fir\n'],
    ['control escapes in pattern and replacement', String.raw`s/\t/\n/`, 'oak\telm\n', 'oak\nelm\n'],
    ['literal backslash followed by a digit', String.raw`s/\\1/X/`, '\\1\n', 'X\n'],
    ['ERE literal backslash followed by a digit', String.raw`s/\\1/X/`, '\\1\n', 'X\n', '-E'],
    ['omitted BRE lower interval bound', String.raw`s/a\{,2\}/X/`, 'aaab\n', 'Xab\n'],
    ['global omitted BRE lower interval bound', String.raw`s/a\{,2\}/X/g`, 'aaab\n', 'XXbX\n'],
    ['omitted ERE lower interval bound', 's/a{,2}/X/g', 'aaab\n', 'XXbX\n', '-E'],
    ['omitted BRE interval bounds', String.raw`s/a\{,\}/X/g`, 'aaab\n', 'XbX\n'],
    ['omitted ERE interval bounds', 's/a{,}/X/g', 'aaab\n', 'XbX\n', '-E'],
    ['substitution print without default output', 's/oak/elm/p', 'oak\nfir\n', 'elm\n', '-n'],
    ['substitution print plus default output', 's/oak/elm/p', 'oak\nfir\n', 'elm\nelm\nfir\n'],
    ['global print emits once per record', 's/oak/elm/gp', 'oakoak\nfir\n', 'elmelm\n', '-n'],
    ['newline separates script commands', 's/oak/elm/\ns/elm/fir/', 'oak\n', 'fir\n'],
  ]
  for (const [name, script, input, stdout, flags] of cases) {
    it(name, () => check(script, input, stdout, flags))
  }
  for (const [input, output] of [['', 'X'], ['b', 'XbX'], ['bc', 'XbXcX'], ['bac', 'XbXcX'], ['baac', 'XbXcX']]) {
    it(`global empty matches in ${JSON.stringify(input)}`, () => check('s/a*/X/g', input + '\n', output + '\n'))
  }
})

describe('GNU sed audit — address ranges', () => {
  const input = 'stop\nbody\nstop\nafter\nlast\n'
  for (const [script, stdout] of [
    ['0,/stop/p', 'stop\n'],
    ['1,/stop/p', 'stop\nbody\nstop\n'],
    ['2,+1p', 'body\nstop\n'],
    ['2,+0p', 'body\n'],
    ['3,1p', 'stop\n'],
    ['/stop/,3p', 'stop\nbody\nstop\n'],
    ['1,2p;2,4p', 'stop\nbody\nbody\nstop\nafter\n'],
    ['2,$p', 'body\nstop\nafter\nlast\n'],
    ['/missing/,$p', ''],
    ['s/body/end/;/end/,/last/p', 'end\nstop\nafter\nlast\n'],
  ]) it(script, () => check(script, input, stdout, '-n'))

  it('uses cumulative addresses and separates missing final newlines across operands', () => {
    const result = createTerminal({ first: 'oak', empty: '', last: 'elm\nfir' }).run("sed -n '2,$p' first empty last")
    assert.deepEqual(result, { stdout: 'elm\nfir', stderr: '', exitCode: 0, cwd: '/', unsupported: [] })
  })
})

describe('GNU sed audit — unavailable features remain observable', () => {
  const scripts = [
    's/oak/elm/2', 's/oak/elm/I', 's/oak/elm/M', 's/oak/elm/e', 's/oak/elm/w output',
    String.raw`s/oak/\U&/`, String.raw`s/oak/\0/`, String.raw`s/oak/\x41/`,
    String.raw`s/oak/\o101/`, String.raw`s/oak/\d65/`, String.raw`s/oak/\Q/`,
    '1~2p', '2,~3p', String.raw`\#oak#p`, '/oak/Ip', '/oak/Mp',
    '/oak/!p', '/oak/{p;}', 's/oak/elm/;s//fir/', 's/oak/elm/ # comment',
    'y/oak/elm/', 'd', 'D', 'N', 'h', 'H', 'g', 'G', 'x', 'q', 'r input', 'w output',
    String.raw`s/\(oak\)\1/elm/`,
  ]
  for (const script of scripts) {
    it(script, () => {
      const terminal = createTerminal({ input: 'oakoak\n' })
      const command = `sed ${quote(script)} input`
      const result = terminal.run(command)
      assert.notEqual(result.exitCode, 0)
      assert.match(result.stderr, /sed:/u)
      assert.ok(result.unsupported.length > 0)
      assert.ok(result.unsupported.every(({ command: name }) => name === 'sed'))
      const hidden = terminal.run(`${command} 2>/dev/null | cat`)
      assert.equal(hidden.stderr, '')
      assert.equal(hidden.exitCode, 0)
      assert.deepEqual(hidden.unsupported, result.unsupported)
    })
  }
})

describe('GNU sed audit — invalid syntax is an ordinary error', () => {
  // sed/regexp.c selects POSIX syntax flags, unlike GNU grep and AWK:
  // https://github.com/mirror/sed/blob/0c1fe22ccacf4887e0be6c11deb4e9c83acc287d/sed/regexp.c
  for (const [flags, patterns] of [
    ['-E', ['a)', ')', '(a', '*a', '+a', '?a', '{1}a', '^*', String.raw`\b*`, 'a{z}', 'a{1', 'a{}']],
    ['', ['a**', String.raw`a\+*`, String.raw`a*\{2\}`, String.raw`a\{2\}*`, String.raw`\{1\}`, String.raw`\b\{1\}`]],
  ]) {
    for (const pattern of patterns) {
      it(`rejects invalid ${flags || 'BRE'} repetition or grouping: ${pattern}`, () => {
        const result = createTerminal({ input: pattern + '\n' }).run(`sed ${flags} ${quote(`s/${pattern}/X/`)} input`)
        assert.equal(result.stdout, '')
        assert.equal(result.exitCode, 1)
        assert.notEqual(result.stderr, '')
        assert.deepEqual(result.unsupported, [])
      })
    }
  }
  for (const [flags, script] of [['-E', 's/a{,32768}/X/'], ['', String.raw`s/a\{,32768\}/X/`]]) {
    it(`validates repetition bounds with an omitted minimum: ${script}`, () => {
      const result = createTerminal({ input: 'a\n' }).run(`sed ${flags} ${quote(script)} input`)
      assert.equal(result.exitCode, 1)
      assert.match(result.stderr, /Regular expression too big/u)
      assert.deepEqual(result.unsupported, [])
    })
  }
  for (const script of [String.raw`/\1/,$p`, String.raw`s/\(oak\1\)/elm/`, String.raw`s/\1\(oak\)/elm/`, String.raw`s/oak/\1/`, String.raw`s/oak\{x\}/elm/`, 's/oak/elm/gg', 's/oak/elm/pp']) {
    for (const input of ['', 'oakoak\n']) {
      it(`${script} with ${input ? 'nonempty' : 'empty'} input`, () => {
        const result = createTerminal({ input }).run(`sed ${quote(script)} input`)
        assert.equal(result.stdout, '')
        assert.equal(result.exitCode, 1)
        assert.notEqual(result.stderr, '')
        assert.deepEqual(result.unsupported, [])
      })
    }
  }
})
