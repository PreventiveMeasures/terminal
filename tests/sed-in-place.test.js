import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { preprocessInPlace } from '../src/commands/sed-in-place.js'

// GNU sed 4.9 sed.c handles -i's attached optional suffix; execute.c
// open_next_file/closedown/process_files define per-file replacement and q.
// https://git.savannah.gnu.org/cgit/sed.git/tree/sed/sed.c?h=v4.9
// https://git.savannah.gnu.org/cgit/sed.git/tree/sed/execute.c?h=v4.9
const FILES = { input: 'a\nb\na\n', second: 'c\nd\n', script: 's/a/A/\n' }
const expected = (stdout = '', exitCode = 0, stderr = '', unsupported = [], cwd = '/src') => ({ stdout, stderr, exitCode, cwd, notes: [], unsupported })

async function terminal() {
  const t = createTerminal(FILES, { mount: '/src/', writable: '/tmp/' })
  assert.deepEqual(await t.run('cat /src/input >/tmp/input; cat /src/second >/tmp/second'), expected())
  return t
}

async function contents(t, path, text, cwd = '/src') {
  assert.deepEqual(await t.run(`cat ${path}`), expected(text, 0, '', [], cwd))
}

describe('sed in-place optional arguments respect option boundaries', () => {
  const cases = [
    [['-i', 's/a/A/', 'input'], ['s/a/A/', 'input'], ''],
    [['--in-place', 's/a/A/', 'input'], ['s/a/A/', 'input'], ''],
    [['--in-place=', 's/a/A/', 'input'], ['s/a/A/', 'input'], ''],
    [['-i.bak', 's/a/A/', 'input'], ['s/a/A/', 'input'], '.bak'],
    [['--in-place=.bak', 's/a/A/', 'input'], ['s/a/A/', 'input'], '.bak'],
    [['-ni', '-e', 'p', 'input'], ['-n', '-e', 'p', 'input'], ''],
    [['-Ei', 's/a/A/', 'input'], ['-E', 's/a/A/', 'input'], ''],
    [['-iE', 's/a/A/', 'input'], ['s/a/A/', 'input'], 'E'],
    [['-i.bak', '-i', 'p', 'input'], ['p', 'input'], ''],
    [['-e', '-i', 'input'], ['-e', '-i', 'input'], null],
    [['-f', '--in-place', 'input'], ['-f', '--in-place', 'input'], null],
    [['--expression', '-i', 'input'], ['--expression', '-i', 'input'], null],
    [['--file', '--in-place=.bak', 'input'], ['--file', '--in-place=.bak', 'input'], null],
    [['-nei', 'input'], ['-nei', 'input'], null],
    [['-e-i', 'input'], ['-e-i', 'input'], null],
    [['--', '-i', 'input'], ['--', '-i', 'input'], null],
    [['-i', '-e', '--', 'input'], ['-e', '--', 'input'], ''],
    [['-i', '', '-'], ['', '-'], ''],
  ]
  for (const [tokens, remaining, inPlace] of cases) {
    it(JSON.stringify(tokens), () => assert.deepEqual(preprocessInPlace(tokens), { tokens: remaining, inPlace }))
  }
})

describe('sed edits only its requested writable input files', () => {
  for (const option of ['-i', '--in-place', '--in-place=', '-Ei']) {
    it(option, async () => {
      const t = await terminal()
      assert.deepEqual(await t.run(`sed ${option} 's/a/A/' /tmp/input`), expected())
      await contents(t, '/tmp/input', 'A\nb\nA\n')
      await contents(t, '/src/input', FILES.input)
    })
  }
  for (const run of [
    "sed -i -e 's/a/x/' -e 's/x/A/' /tmp/input",
    "sed /tmp/input -i -f /src/script",
    "sed -i 's/a/A/' -- /tmp/input",
  ]) {
    it(run, async () => {
      const t = await terminal()
      assert.deepEqual(await t.run(run), expected())
      await contents(t, '/tmp/input', 'A\nb\nA\n')
    })
  }
  it('quiet mode replaces the file with explicitly printed records only', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run("sed -ni '2p' /tmp/input"), expected())
    await contents(t, '/tmp/input', 'b\n')
  })
  it('quiet mode without a print command replaces the file with empty content', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run("sed -ni 's/a/A/' /tmp/input"), expected())
    await contents(t, '/tmp/input', '')
  })
  it('resets numeric ranges and line numbers for each input file', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run("sed -ni '1,2p;=' /tmp/input /tmp/second"), expected())
    await contents(t, '/tmp/input', 'a\n1\nb\n2\n3\n')
    await contents(t, '/tmp/second', 'c\n1\nd\n2\n')
  })
  it('matches the last address separately for each file', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run("sed -i '$d' /tmp/input /tmp/second"), expected())
    await contents(t, '/tmp/input', 'a\nb\n')
    await contents(t, '/tmp/second', 'c\n')
  })
  it('preserves independent missing final delimiters and empty inputs', async () => {
    const t = await terminal()
    await t.run('printf a >/tmp/input; >/tmp/empty; printf c >/tmp/second')
    assert.deepEqual(await t.run("sed -i 's/./X/' /tmp/input /tmp/empty /tmp/second"), expected())
    await contents(t, '/tmp/input', 'X')
    await contents(t, '/tmp/empty', '')
    await contents(t, '/tmp/second', 'X')
  })
  it('supports NUL-delimited input without inserting line delimiters', async () => {
    const t = await terminal()
    await t.run("printf 'a\\0b\\0a' >/tmp/input")
    assert.deepEqual(await t.run("sed -zi 's/a/A/' /tmp/input"), expected())
    await contents(t, '/tmp/input', 'A\0b\0A')
  })
  it('treats explicit dash as a literal file under in-place editing', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run("cd /tmp; echo a >-; sed -i s/a/A/ -; cat ./-"), expected('A\n', 0, '', [], '/tmp'))
  })
  it('edits a filename beginning with -i after the option terminator', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run("cd /tmp; echo a >-input; sed -i -e s/a/A/ -- -input; cat ./-input"), expected('A\n', 0, '', [], '/tmp'))
  })
})

describe('sed in-place backups preserve the original file', () => {
  for (const option of ['-i.bak', '--in-place=.bak', "-i'*.bak'"]) {
    it(option, async () => {
      const t = await terminal()
      assert.deepEqual(await t.run(`sed ${option} 's/a/A/' /tmp/input`), expected())
      await contents(t, '/tmp/input', 'A\nb\nA\n')
      await contents(t, '/tmp/input.bak', FILES.input)
    })
  }
  it('an option following -i belongs to its suffix when attached', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run("sed -iE 's/a/A/' /tmp/input"), expected())
    await contents(t, '/tmp/inputE', FILES.input)
  })
  it('backs up even when no substitution occurs and overwrites existing backups', async () => {
    const t = await terminal()
    await t.run('echo stale >/tmp/input.bak')
    assert.deepEqual(await t.run("sed -i.bak 's/absent/X/' /tmp/input"), expected())
    await contents(t, '/tmp/input', FILES.input)
    await contents(t, '/tmp/input.bak', FILES.input)
  })
  it('expands each star against the original operand spelling', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run("cd /tmp; sed -i'*-*' s/a/A/ input; cat input-input"), expected(FILES.input, 0, '', [], '/tmp'))
    await contents(t, '/tmp/input', 'A\nb\nA\n', '/tmp')
  })
  it('star expansion preserves dollar sequences in the input filename', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run("cd /tmp; echo a >'d$&'; sed -i'*.bak' s/a/A/ 'd$&'; cat 'd$&.bak'"), expected('a\n', 0, '', [], '/tmp'))
  })
  for (const option of ["-i'*'", '-i.bak -i', '-i.bak --in-place=']) {
    it(`no backup with ${option}`, async () => {
      const t = await terminal()
      assert.deepEqual(await t.run(`sed ${option} 's/a/A/' /tmp/input`), expected())
      assert.deepEqual(await t.run('test -f /tmp/input.bak'), expected('', 1))
    })
  }
})

describe('sed in-place quit and errors preserve the right files', () => {
  for (const code of [0, 7]) {
    it(`q ${code} commits the current prefix and leaves later files alone`, async () => {
      const t = await terminal()
      assert.deepEqual(await t.run(`sed -i.bak -e s/a/A/ -e '1q ${code}' /tmp/input /tmp/second`), expected('', code))
      await contents(t, '/tmp/input', 'A\n')
      await contents(t, '/tmp/input.bak', FILES.input)
      await contents(t, '/tmp/second', FILES.second)
      assert.deepEqual(await t.run('test -f /tmp/second.bak'), expected('', 1))
    })
  }
  it('a quiet quit commits an empty current file', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('sed -ni q /tmp/input /tmp/second'), expected())
    await contents(t, '/tmp/input', '')
    await contents(t, '/tmp/second', FILES.second)
  })
  it('empty files do not execute q or prevent later editing', async () => {
    const t = await terminal()
    await t.run('>/tmp/empty')
    assert.deepEqual(await t.run('sed -i q /tmp/empty /tmp/input'), expected())
    await contents(t, '/tmp/empty', '')
    await contents(t, '/tmp/input', 'a\n')
  })
  for (const run of ['sed -i p', 'sed -i -e ""', "printf data | sed -i 's/a/A/'"]) {
    it(`requires explicit input files: ${run}`, async () => assert.deepEqual(await (await terminal()).run(run), expected('', 4, 'sed: no input files\n')))
  }
  it('an absent explicit dash does not consume pipeline input', async () => {
    assert.deepEqual(await (await terminal()).run('printf a | sed -i p -'), expected('', 2, 'sed: can\'t read -: No such file or directory\n'))
  })
  it('missing inputs do not prevent later existing inputs from being edited', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('sed -i s/a/A/ /tmp/missing /tmp/input'), expected('', 2, 'sed: can\'t read /tmp/missing: No such file or directory\n'))
    await contents(t, '/tmp/input', 'A\nb\nA\n')
  })
  it('missing-input status takes precedence over a later q exit code', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run("sed -i 'q7' /tmp/missing /tmp/input"), expected('', 2, 'sed: can\'t read /tmp/missing: No such file or directory\n'))
    await contents(t, '/tmp/input', 'a\n')
  })
  for (const name of ['/tmp', '/dev/null', '/dev/stdin']) {
    it(`rejects nonregular input: ${name}`, async () => {
      assert.deepEqual(await (await terminal()).run(`printf a | sed -i p ${name}`), expected('', 4, `sed: couldn't edit ${name}: not a regular file\n`))
    })
  }
  it('stops at a directory after committing earlier files', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('sed -i s/a/A/ /tmp/input /tmp /tmp/second'), expected('', 4, "sed: couldn't edit /tmp: not a regular file\n"))
    await contents(t, '/tmp/input', 'A\nb\nA\n')
    await contents(t, '/tmp/second', FILES.second)
  })
  it('syntax errors preserve input and do not create backups', async () => {
    const t = await terminal()
    const result = await t.run("sed -i.bak 's/a' /tmp/input")
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported, [])
    await contents(t, '/tmp/input', FILES.input)
    assert.deepEqual(await t.run('test -f /tmp/input.bak'), expected('', 1))
  })
  it('unsupported runtime matching preserves input and reports diagnostics', async () => {
    const t = await terminal()
    await t.run('printf "\u1C80\\n" >/tmp/input')
    const result = await t.run("sed -i.bak 's/в/X/I' /tmp/input")
    assert.equal(result.exitCode, 1)
    assert.equal(result.unsupported.length, 1)
    await contents(t, '/tmp/input', '\u1C80\n')
    assert.deepEqual(await t.run('test -f /tmp/input.bak'), expected('', 1))
  })
  it('a missing backup parent fails ordinarily and preserves the original', async () => {
    const t = await terminal()
    const result = await t.run("sed --in-place='/tmp/missing/*' s/a/A/ /tmp/input")
    assert.equal(result.exitCode, 4)
    assert.deepEqual(result.unsupported, [])
    await contents(t, '/tmp/input', FILES.input)
  })
  it('a backup directory cannot replace the original file', async () => {
    const t = await terminal()
    const result = await t.run("sed --in-place='/tmp/*/..' s/a/A/ /tmp/input")
    assert.equal(result.exitCode, 4)
    assert.deepEqual(result.unsupported, [])
    await contents(t, '/tmp/input', FILES.input)
  })
})

describe('sed in-place permissions remain visible on the diagnostic channel', () => {
  for (const writable of [false, '/tmp/']) {
    it(`refuses source mutation with writable=${writable}`, async () => {
      const t = createTerminal(FILES, { mount: '/src/', writable })
      const message = 'sed: /src/input: file system is read-only'
      const unsupported = [{ kind: 'feature', command: 'sed', detail: '-i', message }]
      assert.deepEqual(await t.run('sed -i s/a/A/ /src/input'), expected('', 1, message + '\n', unsupported))
      assert.deepEqual(await t.run('sed -i s/a/A/ /src/input 2>/dev/null | cat'), expected('', 0, '', unsupported))
      await contents(t, '/src/input', FILES.input)
    })
  }
  it('refuses a backup outside the writable area without modifying either file', async () => {
    const t = await terminal()
    const result = await t.run("sed --in-place='/src/*' s/a/A/ /tmp/input")
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['-i'])
    await contents(t, '/tmp/input', FILES.input)
    await contents(t, '/src/input', FILES.input)
  })
})
