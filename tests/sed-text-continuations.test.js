import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed 4.9 compile.c read_text/compile_program/check_final_program and
// execute.c output_line/dump_append_queue distinguish resumed text from
// final pending text. These expectations are derived from those routines.
// https://git.savannah.gnu.org/cgit/sed.git/tree/sed/compile.c?h=v4.9
// https://git.savannah.gnu.org/cgit/sed.git/tree/sed/execute.c?h=v4.9
const FILES = {
  input: 'line\n', unterminated: 'line', empty: '', zero: 'line\0',
  'scripts/append': 'a\\', 'scripts/insert': 'i\\', 'scripts/change': 'c\\',
  'scripts/first': 'first\\', 'scripts/last': 'last\n', 'scripts/empty': '',
  'scripts/commands': '  text\np\n',
}
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const expressions = (...scripts) => scripts.map((script) => '-e ' + quote(script)).join(' ')
const expected = (stdout, exitCode = 0, stderr = '', unsupported = []) => ({ stdout, stderr, exitCode, cwd: '/', unsupported })
const command = (args, file = 'input', flags = '') => `sed ${flags} ${args} ${file}`

function check(args, stdout, file = 'input', flags = '') {
  assert.deepEqual(createTerminal(FILES).run(command(args, file, flags)), expected(stdout))
}

describe('sed text resumes across expression boundaries', () => {
  it('supports the exact split-expression insert command', () => {
    const result = createTerminal({ input: 'qwe rty\n' }).run("sed -e 'i\\' -e 'TEXT' input")
    assert.deepEqual(result, expected('TEXT\nqwe rty\n'))
  })
  const cases = [
    [['\\', 'first'], 'first\n'],
    [[' first\\', 'second'], 'first\nsecond\n'],
    [['\\\nfirst\\', 'second'], 'first\nsecond\n'],
    [['\\', 'first\\', 'second\\', 'third'], 'first\nsecond\nthird\n'],
    [['\\', '\\', 'third'], '\nthird\n'],
    [['\\', '  leading blanks'], '  leading blanks\n'],
    [['\\', '; # } q /bad/'], '; # } q /bad/\n'],
    [['\\', '\\0'], '0\n'],
    [['\\', '\\x41\\nend'], 'A\nend\n'],
    [[' first\\', '\\0'], 'first\n0\n'],
  ]
  for (const kind of ['a', 'i', 'c']) {
    for (const [parts, text] of cases) {
      it(`${kind} ${JSON.stringify(parts)}`, () => {
        const args = expressions(kind + parts[0], ...parts.slice(1))
        const stdout = kind === 'a' ? FILES.input + text : kind === 'i' ? text + FILES.input : text
        check(args, stdout)
        check(args, text, 'input', '-n')
      })
    }
    it(`${kind} empty later expression completes an empty text line`, () => {
      const text = '\n'
      check(expressions(kind + '\\', ''), kind === 'a' ? FILES.input + text : kind === 'i' ? text + FILES.input : text)
    })
    it(`${kind} completed text lets later expressions resume command parsing`, () => {
      const stdout = kind === 'a' ? 'line\n\n' : kind === 'i' ? '\nline\n' : '\n'
      check(expressions(kind + '\\', '', 'p'), stdout, 'input', '-n')
    })
    it(`${kind} completion does not cross a normal text-ending newline`, () => {
      const text = 'one\ntwo\n'
      const stdout = kind === 'a' ? 'line\n' + text : kind === 'i' ? text + 'line\n' : text
      check(expressions(kind + '\\', 'one\\\ntwo\np'), stdout, 'input', '-n')
    })
    it(`${kind} NUL mode keeps text-source line endings`, () => {
      const text = kind === 'a' ? 'first\nsecond\n' : 'first\nsecond\0'
      check(expressions(kind + ' first\\', 'second'), text, 'zero', '-zn')
    })
  }
})

describe('sed text continuation honors script file and option order', () => {
  const cases = [
    [expressions('a\\') + ' -f scripts/last', 'line\nlast\n'],
    ['-f scripts/append ' + expressions('last'), 'line\nlast\n'],
    ['-f scripts/insert -f scripts/first ' + expressions('last'), 'first\nlast\nline\n'],
    ['-f scripts/change -f scripts/first -f scripts/last', 'first\nlast\n'],
    ['-f scripts/append -f scripts/empty ' + expressions('p'), 'line\nline\n\n'],
    ['-f scripts/insert -f scripts/commands', '  text\nline\nline\n'],
    [expressions('a\\') + ' --expression=last', 'line\nlast\n'],
    ['--expression=' + quote('i\\') + ' --file=scripts/last', 'last\nline\n'],
    [expressions('a\\') + ' -E ' + expressions('tail', 's/l+/L/'), 'Line\ntail\n'],
    [expressions('{a\\', 'literal }\n}'), 'line\nliteral }\n'],
    [expressions('a\\', 'tail\n/a/p'), 'line\ntail\n'],
  ]
  for (const [args, stdout] of cases) it(args, () => check(args, stdout))

  it('reads continuation text from script stdin before data input', () => {
    const run = "printf 'tail\\n' | sed " + expressions('a\\') + ' -f - input'
    assert.deepEqual(createTerminal(FILES).run(run), expected('line\ntail\n'))
  })
  it('consumed script stdin is not reused as data', () => {
    const run = "printf 'tail\\n' | sed " + expressions('a\\') + ' -f -'
    assert.deepEqual(createTerminal(FILES).run(run), expected(''))
  })
  it('missing continuation script files fail before input execution', () => {
    const result = createTerminal(FILES).run(command(expressions('p', 'a\\') + ' -f missing'))
    assert.equal(result.stdout, '')
    assert.equal(result.exitCode, 4)
    assert.match(result.stderr, /missing: no such file/u)
    assert.deepEqual(result.unsupported, [])
  })
})

describe('sed final text EOF retains pending raw bytes and NULL text', () => {
  for (const kind of ['a', 'i', 'c']) {
    it(`${kind} bare final backslash does not print an empty text line`, () => {
      check(quote(kind + '\\'), kind === 'c' ? '' : 'line\n')
      check(expressions(kind + '\\'), kind === 'c' ? '' : 'line\n')
      check(expressions(kind + '\\'), '', 'input', '-n')
      check(expressions(kind + '\\'), '', 'empty')
    })
    it(`${kind} NULL text keeps its own missing-delimiter behavior`, () => {
      const stdout = kind === 'a' ? 'line\n' : kind === 'i' ? 'line' : ''
      check(expressions(kind + '\\'), stdout, 'unterminated')
      check(expressions('p', kind + '\\'), kind === 'a' ? 'line\n' : 'line', 'unterminated', '-n')
    })
    for (const raw of [String.raw`\0`, String.raw`\x80`, String.raw`\c\x`, String.raw`\n\t`]) {
      it(`${kind} final pending ${raw} stays literal`, () => {
        const args = expressions(kind + '\\', raw + '\\')
        check(args, raw + '\n', 'input', '-n')
        check(args, raw + (kind === 'a' ? '\n' : '\0'), 'zero', '-zn')
      })
    }
    it(`${kind} an empty later source completes and normalizes pending text`, () => {
      check(expressions(kind + '\\', String.raw`\0` + '\\', ''), '0\n\n', 'input', '-n')
    })
  }
  it('pending text is scoped to one sed invocation', () => {
    const terminal = createTerminal(FILES)
    assert.deepEqual(terminal.run(command(expressions('a\\'))), expected('line\n'))
    assert.deepEqual(terminal.run(command(expressions('p'), 'input', '-n')), expected('line\n'))
  })
})

describe('sed continuation syntax and normalization failures remain precise', () => {
  it('a closing brace absorbed as text cannot close a command block', () => {
    assert.deepEqual(createTerminal(FILES).run(command(expressions('{a\\', '}'))), expected('', 1, "sed: unmatched '{'\n"))
  })
  it('a later source triggers ordinary recursive control escape validation', () => {
    const args = expressions('a\\', String.raw`\c\x` + '\\', '')
    assert.deepEqual(createTerminal(FILES).run(command(args)), expected('', 1, 'sed: recursive escaping after \\c not allowed\n'))
  })
  it('unrepresentable completed byte text still reaches diagnostics', () => {
    const run = command(expressions('a\\', String.raw`\x80` + '\\', ''))
    const message = 'sed: byte output that is not valid UTF-8 cannot be represented by this string-based terminal'
    const unsupported = [{ kind: 'feature', command: 'sed', detail: 'partial UTF-8 byte sequence', message }]
    const terminal = createTerminal(FILES)
    assert.deepEqual(terminal.run(run), expected('', 1, message + '\n', unsupported))
    assert.deepEqual(terminal.run(run + ' 2>/dev/null | cat'), expected('', 0, '', unsupported))
  })
  it('unsupported commands after completed text retain their diagnostic', () => {
    const run = command(expressions('a\\', 'tail\nF'))
    const terminal = createTerminal(FILES)
    const result = terminal.run(run)
    assert.equal(result.stdout, '')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['script'])
    assert.deepEqual(terminal.run(run + ' 2>/dev/null | cat'), expected('', 0, '', result.unsupported))
  })
  it('zero escapes remain literal zero in transliteration text', () => {
    assert.deepEqual(createTerminal({ input: '0\n' }).run(String.raw`sed 'y/\0/x/' input`), expected('x\n'))
  })
})

describe('sed quit flushes a pending record delimiter before append text', () => {
  for (const flags of ['', '-z']) {
    const delimiter = flags ? '\0' : '\n'
    it(`q flushes preceding output with ${flags || 'line'} delimiters`, () => {
      check(expressions('q'), 'line' + delimiter, 'unterminated', flags)
      check(expressions('p', 'q'), 'line' + delimiter, 'unterminated', flags + ' -n')
      check(expressions('q'), '', 'unterminated', flags + ' -n')
    })
    it(`q preserves raw append ending after its flush with ${flags || 'line'} delimiters`, () => {
      check(expressions(String.raw`a tail\c`, 'q'), 'line' + delimiter + 'tailJ', 'unterminated', flags)
    })
  }
})
