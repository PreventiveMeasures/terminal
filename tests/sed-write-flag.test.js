import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed 4.9 compile.c read_filename/get_openfile/mark_subst_opts and
// execute.c do_subst/output_line define these results without native oracles.
const FILES = {
  input: 'qwe\nskip\nqwe qwe\n', single: 'qwe\n', empty: '', unterminated: 'qwe',
  nul: 'qwe\0skip\0qwe qwe\0', nulLast: 'qwe\0qwe',
  'scripts/write': 's/qwe/Z/w out\n', 'scripts/second': 's/Z/Y/w out\n',
}
const OPTIONS = { mount: '/repo', cwd: '/tmp', writable: '/tmp/' }
const terminal = () => createTerminal(FILES, OPTIONS)
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const command = (script, input = '/repo/input', flags = '') => `sed ${flags} ${quote(script)} ${input}`

function check(t, text, stdout = '', stderr = '', exitCode = 0) {
  assert.deepEqual(t.run(text), { stdout, stderr, exitCode, cwd: '/tmp', unsupported: [] }, text)
}

function written(t, path, content) {
  check(t, `cat ${quote(path)}`, content)
}

describe('sed substitution w writes only successful substitutions', () => {
  for (const [name, script, flags, stdout, output] of [
    ['the reported command', 's/qwe/Z/w out', '', 'Z\nskip\nZ qwe\n', 'Z\nZ qwe\n'],
    ['quiet output', 's/qwe/Z/w out', '-n', '', 'Z\nZ qwe\n'],
    ['p before w', 's/qwe/Z/pw out', '-n', 'Z\nZ qwe\n', 'Z\nZ qwe\n'],
    ['p plus automatic output', 's/qwe/Z/pw out', '', 'Z\nZ\nskip\nZ qwe\nZ qwe\n', 'Z\nZ qwe\n'],
    ['global substitutions write once per pattern space', 's/qwe/Z/gw out', '', 'Z\nskip\nZ Z\n', 'Z\nZ Z\n'],
    ['numeric occurrence', 's/qwe/Z/2w out', '', 'qwe\nskip\nqwe Z\n', 'qwe Z\n'],
    ['numeric and global flags', 's/qwe/Z/2gpw out', '-n', 'qwe Z\n', 'qwe Z\n'],
    ['replacement equal to the match still succeeds', 's/qwe/qwe/w out', '-n', '', 'qwe\nqwe qwe\n'],
    ['empty replacements still write the whole line', 's/qwe//w out', '-n', '', '\n qwe\n'],
    ['unchanged empty matches still succeed', 's/^//w out', '-n', '', 'qwe\nskip\nqwe qwe\n'],
    ['inverted address', '/skip/!s/qwe/Z/w out', '-n', '', 'Z\nZ qwe\n'],
    ['selected numeric range', '2,3s/qwe/Z/w out', '-n', '', 'Z qwe\n'],
  ]) {
    it(name, () => {
      const t = terminal()
      check(t, command(script, '/repo/input', flags), stdout)
      written(t, 'out', output)
      written(t, '/repo/input', FILES.input)
    })
  }

  it('writes the pattern space before later commands modify it', () => {
    const t = terminal()
    check(t, "sed -e 's/qwe/Z/w out' -e 's/Z/Y/g' /repo/input", 'Y\nskip\nY qwe\n')
    written(t, 'out', 'Z\nZ qwe\n')
  })

  it('writes a multiline replacement as one complete pattern space', () => {
    const t = terminal()
    check(t, command(String.raw`s/qwe/X\nY/w out`, '/repo/single'), 'X\nY\n')
    written(t, 'out', 'X\nY\n')
  })
})

describe('sed opens substitution output files while compiling the script', () => {
  for (const [name, script, input, stdout] of [
    ['empty input', 's/qwe/Z/w out', '/repo/empty', ''],
    ['unselected address', '20s/qwe/Z/w out', '/repo/single', 'qwe\n'],
    ['no matching text', 's/absent/Z/w out', '/repo/single', 'qwe\n'],
    ['unselected block', '20{\ns/qwe/Z/w out\n}', '/repo/single', 'qwe\n'],
    ['earlier quit', 'q\ns/qwe/Z/w out', '/repo/single', 'qwe\n'],
  ]) {
    it(`truncates existing output with ${name}`, () => {
      const t = terminal()
      check(t, 'printf old >out')
      check(t, command(script, input), stdout)
      written(t, 'out', '')
    })
  }

  it('creates a missing target even without an input cycle', () => {
    const t = terminal()
    check(t, command('s/qwe/Z/w out', '/repo/empty'))
    check(t, 'test -f out')
    written(t, 'out', '')
  })

  it('truncates a target before reading it as an input operand', () => {
    const t = terminal()
    check(t, 'cat /repo/single >out')
    check(t, command('s/qwe/Z/w out', 'out'))
    written(t, 'out', '')
  })

  it('creates the output before an ordinary input-open failure', () => {
    const t = terminal()
    const r = t.run(command('s/qwe/Z/w out', 'missing'))
    assert.equal(r.stdout, '')
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /missing/u)
    assert.deepEqual(r.unsupported, [])
    written(t, 'out', '')
  })

  it('makes early truncation visible while loading a later script file', () => {
    const t = terminal()
    check(t, "printf 's/qwe/Y/\\n' >script")
    check(t, "sed -e 's/qwe/Z/w script' -f script /repo/single", 'Z\n')
    written(t, 'script', 'Z\n')
  })

  it('reads a later input file after earlier substitutions have written it', () => {
    const t = terminal()
    check(t, command('s/qwe/Z/w out', '/repo/single out'), 'Z\nZ\n')
    written(t, 'out', 'Z\n')
  })

  it('shares one open file across expressions that use the same filename', () => {
    const t = terminal()
    check(t, "sed -e 's/qwe/X/w out' -e 's/X/Y/w out' /repo/single", 'Y\n')
    written(t, 'out', 'X\nY\n')
  })

  it('shares one open file across script files', () => {
    const t = terminal()
    check(t, 'sed -f /repo/scripts/write -f /repo/scripts/second /repo/single', 'Y\n')
    written(t, 'out', 'Z\nY\n')
  })

  it('keeps separate descriptor offsets for different spellings of one file', () => {
    const t = terminal()
    check(t, "sed -e 's/qwe/X/w out' -e 's/X/Y/w ./out' /repo/single", 'Y\n')
    written(t, 'out', 'Y\n')
  })

  for (const [name, script, flags] of [
    ['later unknown command', 's/qwe/Z/w out\n?', ''],
    ['unfinished block', '{s/qwe/Z/w out}', ''],
    ['invalid expression after w is parsed', 's/(/Z/w out', '-E'],
    ['invalid replacement reference after w is parsed', String.raw`s/qwe/\1/w out`, ''],
  ]) {
    it(`preserves file opening before ${name}`, () => {
      const t = terminal()
      const path = name === 'unfinished block' ? 'out}' : 'out'
      check(t, `printf old >${quote(path)}`)
      const r = t.run(command(script, '/repo/single', flags))
      assert.equal(r.stdout, '')
      assert.equal(r.exitCode, 1)
      assert.notEqual(r.stderr, '')
      assert.deepEqual(r.unsupported, [])
      written(t, path, '')
    })
  }

  it('preserves earlier file openings when a later command is unsupported', () => {
    const t = terminal()
    check(t, 'printf old >out')
    const r = t.run(command('s/qwe/Z/w out\nH', '/repo/single') + ' 2>/dev/null | cat')
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 0)
    assert.ok(r.unsupported.length > 0)
    written(t, 'out', '')
  })

  it('does not open a target when the substitution delimiters are unfinished', () => {
    const t = terminal()
    const r = t.run(command('s/qwe/Z', '/repo/single'))
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.unsupported, [])
    check(t, 'test -f out', '', '', 1)
  })
})

describe('sed w record delimiters belong to each output file', () => {
  it('preserves the final missing newline and separates successive records', () => {
    const t = terminal()
    check(t, command('s/qwe/Z/w out', '/repo/unterminated /repo/unterminated'), 'Z\nZ')
    written(t, 'out', 'Z\nZ')
  })

  it('tracks missing delimiters separately for different files', () => {
    const t = terminal()
    check(t, "sed -e '1s/qwe/X/w out' -e '2s/qwe/Y/w other' /repo/unterminated /repo/unterminated", 'X\nY')
    written(t, 'out', 'X')
    written(t, 'other', 'Y')
  })

  it('tracks missing delimiters across successive writes to one file', () => {
    const t = terminal()
    check(t, "sed -n -e 's/qwe/X/w out' -e 's/X/Y/w out' /repo/unterminated")
    written(t, 'out', 'X\nY')
  })

  it('writes NUL record terminators under -z', () => {
    const t = terminal()
    check(t, command('s/qwe/Z/gw out', '/repo/nul', '-zn'))
    written(t, 'out', 'Z\0Z Z\0')
  })

  it('preserves a missing final NUL and inserts a separator before later output', () => {
    const t = terminal()
    check(t, command('s/qwe/Z/w out', '/repo/nulLast /repo/unterminated', '-zn'))
    written(t, 'out', 'Z\0Z\0Z')
  })
})

describe('sed w filenames consume the rest of the physical script line', () => {
  for (const [script, path] of [
    ['s/qwe/Z/wout', 'out'],
    ['s/qwe/Z/w \t out', 'out'],
    ['s/qwe/Z/w out; p', 'out; p'],
    ['s/qwe/Z/w out#comment', 'out#comment'],
    ['s/qwe/Z/w out}', 'out}'],
    ['s/qwe/Z/w out  ', 'out  '],
    ['s/qwe/Z/w out\r\n', 'out\r'],
    [String.raw`s/qwe/Z/w out\ name`, String.raw`out\ name`],
  ]) {
    it(`uses the literal filename ${JSON.stringify(path)}`, () => {
      const t = terminal()
      check(t, command(script, '/repo/single', '-n'))
      written(t, path, 'Z\n')
    })
  }

  it('a physical newline ends the filename and permits the next command', () => {
    const t = terminal()
    check(t, command('s/qwe/Z/w out\np', '/repo/input', '-n'), 'Z\nskip\nZ qwe\n')
    written(t, 'out', 'Z\nZ qwe\n')
  })

  for (const script of ['s/qwe/Z/w', 's/qwe/Z/w \t']) {
    it(`rejects a missing filename: ${JSON.stringify(script)}`, () => {
      const t = terminal()
      const r = t.run(command(script, '/repo/empty'))
      assert.equal(r.exitCode, 1)
      assert.match(r.stderr, /filename/u)
      assert.deepEqual(r.unsupported, [])
    })
  }
})

describe('sed w standard streams and null device', () => {
  for (const [script, input, flags, stdout, stderr] of [
    ['s/qwe/Z/w /dev/stdout', '/repo/single', '-n', 'Z\n', ''],
    ['s/qwe/Z/pw /dev/stdout', '/repo/single', '-n', 'Z\nZ\n', ''],
    ['s/qwe/Z/w /dev/stdout', '/repo/single', '', 'Z\nZ\n', ''],
    ['s/qwe/Z/w /dev/stderr', '/repo/single', '', 'Z\n', 'Z\n'],
    ['s/qwe/Z/pw /dev/stderr', '/repo/single', '-n', 'Z\n', 'Z\n'],
    ['s/qwe/Z/w /dev/null', '/repo/single', '-n', '', ''],
    ['s/qwe/Z/w /dev/stdout', '/repo/unterminated', '', 'ZZ', ''],
    ['s/qwe/Z/pw /dev/stdout', '/repo/unterminated', '-n', 'ZZ', ''],
    ['s/qwe/Z/w /dev/stdout', '/repo/unterminated /repo/unterminated', '', 'ZZ\nZ\nZ', ''],
    ['s/qwe/Z/w /dev/stderr', '/repo/nulLast', '-zn', '', 'Z\0Z'],
  ]) {
    it(`${script} ${flags} ${input}`, () => {
      const t = terminal()
      check(t, command(script, input, flags), stdout, stderr)
    })
  }

  it('uses the active stdout descriptor without reopening or truncating it', () => {
    const t = terminal()
    check(t, 'printf before >out')
    check(t, command('s/qwe/Z/w /dev/stdout', '/repo/single', '-n') + ' >>out')
    written(t, 'out', 'beforeZ\n')
  })

  it('keeps unsupported diagnostics after writing stderr to a file', () => {
    const t = terminal()
    const r = t.run(command('s/qwe/Z/w /repo/blocked', '/repo/empty') + ' 2>errors | cat')
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 0)
    assert.ok(r.unsupported.length > 0)
    assert.notEqual(t.run('cat errors').stdout, '')
  })
})

describe('sed w distinguishes unsupported writes from ordinary open failures', () => {
  for (const path of ['/repo/single', '/other', '/tmp/../outside']) {
    it(`reports an unsupported write to ${path} before reading empty input`, () => {
      const t = terminal()
      const r = t.run(command(`s/qwe/Z/w ${path}`, '/repo/empty'))
      assert.equal(r.stdout, '')
      assert.notEqual(r.exitCode, 0)
      assert.ok(r.unsupported.length > 0)
      written(t, '/repo/single', 'qwe\n')
    })
  }

  it('keeps normal files read-only when writable mode is disabled', () => {
    const t = createTerminal(FILES, { mount: '/repo', cwd: '/repo' })
    const r = t.run("sed 's/qwe/Z/w out' empty")
    assert.equal(r.stdout, '')
    assert.notEqual(r.exitCode, 0)
    assert.ok(r.unsupported.length > 0)
    assert.deepEqual(t.run('cat single').unsupported, [])
    assert.equal(t.run('cat single').stdout, 'qwe\n')
  })

  for (const path of ['/tmp', '/tmp/missing/out', '/tmp/out/', '/tmp/file/../out']) {
    it(`reports GNU status 4 for ordinary output-open failure: ${path}`, () => {
      const t = terminal()
      check(t, 'printf file >file')
      const r = t.run(command(`s/qwe/Z/w ${path}`, '/repo/empty'))
      assert.equal(r.stdout, '')
      assert.equal(r.exitCode, 4)
      assert.notEqual(r.stderr, '')
      assert.deepEqual(r.unsupported, [])
    })
  }
})

describe('sed substitution output interacts with stdin and in-place descriptors', () => {
  it('refreshes redirected stdin after compiling a write that truncates it', () => {
    const t = terminal()
    check(t, 'cat /repo/single >out')
    check(t, "sed 's/qwe/Z/w out' <out")
    written(t, 'out', '')
  })

  for (const operand of ['-', '/dev/stdin']) {
    it(`refreshes ${operand} when earlier input writes new data before that operand opens`, () => {
      const t = terminal()
      check(t, 'printf old >out')
      check(t, command('s/qwe/Z/w out', `/repo/single ${operand}`) + ' <out', 'Z\nZ\n')
      written(t, 'out', 'Z\n')
    })
  }

  it('reopens /dev/stdin from current file contents after shared stdin was consumed', () => {
    const t = terminal()
    check(t, 'cat /repo/single >out')
    check(t, command('1b;2s/qwe/Z/w /dev/stderr\n3,$p', '- /repo/single /dev/stdin', '-n') + ' <out 2>>out', 'qwe\nZ\n')
    written(t, 'out', 'qwe\nZ\n')
  })

  it('diagnoses reopening a consumed shared stream after its file changes', () => {
    const t = terminal()
    check(t, 'cat /repo/single >out')
    const r = t.run(command('1b;2s/qwe/Z/w /dev/stderr\n3,$p', '- /repo/single -', '-n') + ' <out 2>>out')
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 1)
    assert.ok(r.unsupported.some((note) => note.detail === 'modified redirected input'))
  })

  it('diagnoses writes to a later input while that input is being read', () => {
    const t = terminal()
    const r = t.run(command('s/qwe/qwe/w out', '/repo/single out'))
    assert.equal(r.stdout, 'qwe\n')
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /actively read input/u)
    assert.ok(r.unsupported.some((note) => note.detail === 'streaming self-output'))
    written(t, 'out', 'qwe\n')
  })

  it('diagnoses a write that changes partially consumed redirected stdin', () => {
    const t = terminal()
    check(t, 'cat /repo/input >out')
    const r = t.run("{ head -n1 >/dev/null; sed 's/qwe/Z/w out'; } <out 2>/dev/null | cat")
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 0)
    assert.ok(r.unsupported.some((note) => note.detail === 'modified redirected input'))
    written(t, 'out', '')
  })

  for (const flags of ['-i', '-ni']) {
    it(`w /dev/stdout remains explicit stdout while ${flags} captures edited output`, () => {
      const t = terminal()
      check(t, 'cat /repo/single >out')
      check(t, command('s/qwe/Z/w /dev/stdout', 'out', flags), 'Z\n')
      written(t, 'out', flags === '-i' ? 'Z\n' : '')
    })
  }

  it('an inherited append descriptor keeps writing the original file now named by its backup', () => {
    const t = terminal()
    check(t, 'cat /repo/single >out')
    check(t, "{ sed -i.bak 's/qwe/Z/' out; printf tail; } >>out")
    written(t, 'out', 'Z\n')
    written(t, 'out.bak', 'qwe\ntail')
  })
})
