import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  data: 'alpha\nbeta\nalphabet\nzero\n\nlit.*\n',
  'patterns/alpha': 'alpha\n',
  'patterns/pair': '^alpha$\n^beta$',
  'patterns/empty': '',
  'patterns/blank': '\n',
  'patterns/trailing-blank': 'alpha\n\n',
  'patterns/carriage-return': 'alpha\r\n',
  'patterns/extended': '^(alpha|beta)$\n',
  'patterns/literal': 'lit.*\n',
  'patterns/nul': 'x\0y\n',
  'patterns/bad': '[\n',
  'patterns/unsupported': '\\d\n',
  'crlf-data': 'alpha\r\nalpha\n',
  binary: 'no\nx\0y\n',
  empty: '',
  '-patterns': 'alpha\n',
  '-input': 'alpha\n',
}

function check(command, stdout, exitCode = 0, stderr = '', files = FILES) {
  assert.deepEqual(createTerminal(files).run(command), {
    stdout, stderr, exitCode, cwd: '/', unsupported: [],
  }, command)
}

describe('grep — patterns from virtual files', () => {
  const cases = [
    ['grep -n -f patterns/pair data', '1:alpha\n2:beta\n'],
    ['grep -nfpatterns/pair data', '1:alpha\n2:beta\n'],
    ['grep --file patterns/pair -n data', '1:alpha\n2:beta\n'],
    ['grep data --file=patterns/pair -n', '1:alpha\n2:beta\n'],
    ['grep -f patterns/alpha data', 'alpha\nalphabet\n'],
    ['grep -f patterns/empty data', '', 1],
    ['grep -Pf patterns/empty data', '', 1],
    ['grep -Pvf patterns/empty data', FILES.data],
    ['grep -vf patterns/empty data', FILES.data],
    ['grep -cf patterns/empty data', '0\n', 1],
    ['grep -Lf patterns/empty data', 'data\n', 1],
    ['grep -lf patterns/empty data', '', 1],
    ['grep -f /dev/null data', '', 1],
    ['grep -f patterns/blank data', FILES.data],
    ['grep -xf patterns/blank data', '\n'],
    ['grep -f patterns/trailing-blank data', FILES.data],
    ['grep -f patterns/alpha -f patterns/pair data', 'alpha\nbeta\nalphabet\n'],
    ['grep -f patterns/alpha --file patterns/alpha data', 'alpha\nalphabet\n'],
    ['grep -P -f patterns/alpha -f patterns/alpha data', 'alpha\nalphabet\n'],
    ['grep -f patterns/empty -e beta data', 'beta\n'],
    ['grep -e beta -f patterns/empty data', 'beta\n'],
    ['grep -f patterns/pair -e zero data', 'alpha\nbeta\nzero\n'],
    ['grep -e zero --file=patterns/pair data', 'alpha\nbeta\nzero\n'],
    ['grep -f patterns/carriage-return crlf-data', 'alpha\r\n'],
    ['grep -f -patterns -- -input', 'alpha\n'],
    ['grep -m1 -f patterns/pair data', 'alpha\n'],
    ['grep -c -f patterns/pair data', '2\n'],
    ['grep -of patterns/alpha data', 'alpha\nalpha\n'],
    ['grep -af patterns/nul binary', 'x\0y\n'],
    ['egrep -f patterns/extended data', 'alpha\nbeta\n'],
    ['fgrep -f patterns/literal data', 'lit.*\n'],
    ['fgrep -a -f patterns/nul binary', 'x\0y\n'],
  ]
  for (const [command, stdout, exitCode] of cases) it(command, () => check(command, stdout, exitCode))

  it('distinguishes a trailing newline in -e from a pattern file terminator', () => {
    check("grep -e 'alpha\n' data", FILES.data)
    check('grep -f patterns/alpha data', 'alpha\nalphabet\n')
  })

  it('reads large generated pattern lists without argument-count limits', () => {
    const files = { patterns: 'alpha\n'.repeat(150000), data: FILES.data }
    check('grep -Ff patterns data', 'alpha\nalphabet\n', 0, '', files)
  })

  it('combines checked-in patterns with recursive filters and explicit files', () => {
    const files = {
      'patterns.txt': 'TODO\nFIXME\n',
      'src/a.ts': '// TODO: validate\nexport const a = 1;\n',
      'src/b.ts': '// FIXME: parse\n',
      'src/c.js': '// TODO: ignore\n',
      'README.md': '# Fixture\nTODO: document\n',
    }
    check('grep -rn -f patterns.txt src README.md',
      'src/a.ts:1:// TODO: validate\nsrc/b.ts:1:// FIXME: parse\nsrc/c.js:1:// TODO: ignore\nREADME.md:2:TODO: document\n', 0, '', files)
    check('grep -rlnf patterns.txt src --include=*.ts', 'src/a.ts\nsrc/b.ts\n', 0, '', files)
  })
})

describe('grep — pattern files and shared stdin', () => {
  const cases = [
    ['cat data | grep -f patterns/pair', 'alpha\nbeta\n'],
    ['cat patterns/pair | grep -f - data', 'alpha\nbeta\n'],
    ['cat patterns/pair | grep -f /dev/stdin data', 'alpha\nbeta\n'],
    ['cat patterns/pair | grep -f - -f - data', 'alpha\nbeta\n'],
    ['cat patterns/pair | grep -f -', '', 1],
    ['cat patterns/pair | grep -f - -', '', 1],
    ['cat patterns/pair | grep -f - /dev/stdin', '', 1],
    ['grep -f - - < patterns/alpha', '', 1],
    ['grep -f /dev/stdin < patterns/alpha', 'alpha\n'],
    ['grep -f - /dev/stdin < patterns/alpha', 'alpha\n'],
    ['grep -f /dev/stdin - < patterns/alpha', 'alpha\n'],
    ['{ grep -f - data; cat; } < patterns/alpha', 'alpha\nalphabet\n'],
    ['{ grep -f /dev/stdin data; cat; } < patterns/alpha', 'alpha\nalphabet\nalpha\n'],
    ['{ grep -m0 -f - data; cat; } < patterns/alpha', ''],
  ]
  for (const [command, stdout, exitCode] of cases) it(command, () => check(command, stdout, exitCode))

  it('retains stdin consumption when a later pattern file cannot be read', () => {
    check('{ grep -f missing; cat; } < patterns/alpha', 'alpha\n', 0,
      'grep: missing: no such file or directory\n')
    check('{ grep -f - -f missing data; cat; } < patterns/alpha', '', 0,
      'grep: missing: no such file or directory\n')
  })
})

describe('grep — pattern file errors and diagnostics', () => {
  for (const options of ['-f missing', '-sf missing', '-f missing -s', '--no-messages --file missing', '-qf missing', '-m0 -f missing']) {
    it(`fails before scanning input: ${options}`, () => {
      check(`grep ${options} data`, '', 2, 'grep: missing: no such file or directory\n')
    })
  }

  it('reports directories and invalid path components as ordinary read errors', () => {
    check('grep -sf patterns data', '', 2, 'grep: patterns: is a directory\n')
    check('grep -sf data/../patterns/alpha data', '', 2, 'grep: data/../patterns/alpha: not a directory\n')
  })

  it('keeps input error suppression separate from pattern file errors', () => {
    check('grep -sf patterns/pair missing data', 'data:alpha\ndata:beta\n', 2)
    check('grep -sqf patterns/pair missing data', '')
    check('grep -f patterns/pair missing data', 'data:alpha\ndata:beta\n', 2,
      'grep: missing: no such file or directory\n')
  })

  it('rejects missing option arguments and invalid patterns without unsupported notes', () => {
    for (const command of ['grep -f', 'grep --file', 'grep -sf patterns/bad data']) {
      const result = createTerminal(FILES).run(command)
      assert.equal(result.stdout, '', command)
      assert.equal(result.exitCode, 2, command)
      assert.match(result.stderr, /^grep: .+\n$/u, command)
      assert.deepEqual(result.unsupported, [], command)
    }
  })

  it('mirrors unsupported regex features loaded from files even with -s and redirection', () => {
    const term = createTerminal(FILES)
    const result = term.run('grep -sf patterns/unsupported data')
    assert.equal(result.exitCode, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /not supported/u)
    assert.deepEqual(result.unsupported, [{
      kind: 'feature', command: 'grep', detail: 'regex escape', message: result.stderr.trimEnd(),
    }])
    assert.deepEqual(term.run('grep -sf patterns/unsupported data 2>/dev/null | true'), {
      stdout: '', stderr: '', exitCode: 0, cwd: '/', unsupported: result.unsupported,
    })
  })
})
