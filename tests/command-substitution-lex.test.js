import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readExpansion } from '../src/shell/lex.js'
import { tokenize } from '../src/shell/tokenize.js'
import { unsupportedNote } from '../src/unsupported.js'

describe('command substitution lexical boundaries', () => {
  for (const command of [
    'echo value',
    "printf '%s' ')'",
    'printf "%s" ")"',
    String.raw`printf '%s' \)`,
    String.raw`printf '%s' '$(literal)'`,
    String.raw`printf '%s' "$(printf '%s' ')')"`,
    ' (echo first; (echo second)); echo last',
    'echo first # ) is a comment\necho last',
    'echo value#suffix',
    String.raw`printf '%s' $'\x29'`,
    String.raw`printf '%s' "escaped \" ) quote"`,
    'printf %s $(printf %s $(echo nested))',
    'for value in case; do printf %s "$value"; done',
    'cat <<END\n) " \' $(not executed)\nEND\nprintf done',
    "cat <<FIRST <<'SECOND'\n)\nFIRST\n\"'`\nSECOND\nprintf done",
    'cat <<-END\n\t)\n\tEND\nprintf done',
    'cat <<$(echo "END")\n)\n$(echo "END")\nprintf done',
    'printf %s "`printf )`"',
    'cat <(printf %s ")")',
    'echo "$\\\n(printf %s \')\')"',
  ]) {
    it(`finds the end of ${JSON.stringify(command)}`, () => {
      const raw = `$(${command})`
      assert.deepEqual(readExpansion(`prefix${raw}suffix`, 6), { raw, command })
    })
  }

  it('preserves continuations between the dollar and opening parenthesis', () => {
    assert.deepEqual(readExpansion('$\\\n(echo value)tail', 0), { raw: '$\\\n(echo value)', command: 'echo value' })
  })

  for (const source of ['$(echo', "$(echo 'missing)", '$(echo "missing)', '$( (echo)']) {
    it(`rejects incomplete ${JSON.stringify(source)}`, () => {
      assert.throws(() => readExpansion(source, 0), (error) => {
        assert.equal(unsupportedNote(error), null)
        assert.match(error.message, /unterminated/u)
        return true
      })
    })
  }

  it('scans arithmetic expansions without interpreting their expression', () => {
    for (const source of ['$((1 + 2))', '$\\\n((1 + 2))']) {
      assert.deepEqual(readExpansion(source, 0), { raw: source, arithmetic: '1 + 2' })
    }
  })

  for (const [source, detail] of [
    ['$(case value in value) echo match;; esac)', 'case'],
    ['$(if case value in value) echo match;; esac; then echo yes; fi)', 'case'],
    ['$(while case value in value) echo match;; esac; do echo yes; done)', 'case'],
    ['$( [[ x =~ [)] ]] && echo yes)', '[[ =~'],
    ['$(if [[ x =~ [)] ]]; then echo yes; fi)', '[[ =~'],
    ['$('.repeat(65) + 'echo value' + ')'.repeat(65), 'command substitution depth'],
  ]) {
    it(`diagnoses ${detail}`, () => {
      assert.throws(() => readExpansion(source, 0), (error) => {
        assert.equal(unsupportedNote(error)?.detail, detail)
        return true
      })
    })
  }
})

describe('command substitution word masks', () => {
  it('protects inner source from outer expansion without making a bare word quoted', () => {
    const raw = '$(printf "%s" "$value" ~ {a,b} *.js)'
    const word = tokenize('pre' + raw + 'post')[0]
    assert.deepEqual(word, { kind: 'word', value: 'pre' + raw + 'post', mask: '0000' + '1'.repeat(raw.length - 1) + '0000', quoted: false })
  })

  it('retains the surrounding double-quote context on the active dollar', () => {
    const raw = '$(echo "inner")'
    const word = tokenize(`"pre${raw}post"`)[0]
    assert.deepEqual(word, { kind: 'word', value: 'pre' + raw + 'post', mask: '2222' + '1'.repeat(raw.length - 1) + '2222', quoted: true })
  })

  it('does not rewrite a command substitution before an adjacent quoted fragment', () => {
    const raw = '$(echo value)'
    const word = tokenize(raw + '"suffix"')[0]
    assert.equal(word.value, raw + 'suffix')
    assert.equal(word.mask, '0' + '1'.repeat(raw.length - 1) + '2'.repeat(6))
  })

  it('keeps single-quoted and escaped substitution syntax literal', () => {
    const [single, escaped] = tokenize("'$(echo value)' \\$\\(value\\)")
    assert.equal(single.value, '$(echo value)')
    assert.equal(single.mask, '1'.repeat(single.value.length))
    assert.equal(escaped.value, '$(value)')
    assert.equal(escaped.mask, '11' + '0'.repeat(5) + '1')
  })

  it('does not let opaque inner quoting disable unquoted heredoc expansion', () => {
    const delimiter = '$(echo "END")'
    const tokens = tokenize(`cat <<${delimiter}\n$value\n${delimiter}\n`)
    const heredoc = tokens.find((token) => token.kind === 'redir')
    assert.equal(heredoc.delim, delimiter)
    assert.equal(heredoc.quotedDelim, false)
    assert.equal(heredoc.body, '$value\n')
  })

  it('still recognizes explicit quoting of a literal heredoc delimiter', () => {
    const delimiter = '$(echo "END")'
    const tokens = tokenize(`cat <<'${delimiter}'\n$value\n${delimiter}\n`)
    const heredoc = tokens.find((token) => token.kind === 'redir')
    assert.equal(heredoc.delim, delimiter)
    assert.equal(heredoc.quotedDelim, true)
    assert.equal(heredoc.body, '$value\n')
  })
})
