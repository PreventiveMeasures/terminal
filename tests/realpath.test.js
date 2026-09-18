import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Canonicalization and relative-base rules follow GNU's command and gnulib:
// https://github.com/coreutils/coreutils/blob/master/src/realpath.c
// https://github.com/coreutils/gnulib/blob/master/lib/canonicalize.c
const FILES = { file: 'value', input: 'unconsumed\n', 'dir/child': '', 'dir/sub/leaf': '', 'other/leaf': '', 'dir2/leaf': '', '.hidden': '' }
const terminal = () => createTerminal(FILES)
const result = (stdout = '', cwd = '/') => ({ stdout, stderr: '', exitCode: 0, cwd, notes: [], unsupported: [] })

function success(command, stdout, t = terminal(), cwd = '/') {
  assert.deepEqual(t.run(command), result(stdout, cwd), command)
}

function failure(command, reason, t = terminal()) {
  const actual = t.run(command)
  assert.equal(actual.stdout, '', command)
  assert.equal(actual.exitCode, 1, command)
  assert.match(actual.stderr, reason, command)
  assert.deepEqual(actual.unsupported, [], command)
  return actual
}

describe('realpath canonical names', () => {
  for (const [args, stdout] of [
    ['.', '/\n'], ['/', '/\n'], ['//', '/\n'], ['////', '/\n'],
    ['file', '/file\n'], ['dir', '/dir\n'], ['dir/', '/dir\n'],
    ['dir//./sub/../child', '/dir/child\n'], ['dir/../../../../file', '/file\n'],
    ['dir/.', '/dir\n'], ['dir/..', '/\n'], ['dir/../other/leaf', '/other/leaf\n'],
    ['file file', '/file\n/file\n'], ['.hidden', '/.hidden\n'],
    ['missing', '/missing\n'], ['dir/missing', '/dir/missing\n'], ['missing/', '/missing\n'],
    ['missing///', '/missing\n'], ['dir/missing///', '/dir/missing\n'],
  ]) it(args, () => success('realpath ' + args, stdout))

  for (const options of ['-e', '--canonicalize-existing', '-m', '--canonicalize-missing', '-L', '--logical', '-P', '--physical', '-s', '--strip', '--no-symlinks', '-q', '--quiet', '-eLPs', '-sPL']) {
    it(options + ' preserves existing canonical names', () => success(`realpath ${options} dir//./sub/../child`, '/dir/child\n'))
  }

  it('uses the current directory and does not change it', () => {
    success('cd dir/sub; realpath . ../child ../../file /other/leaf; pwd', '/dir/sub\n/dir/child\n/file\n/other/leaf\n/dir/sub\n', terminal(), '/dir/sub')
  })

  it('keeps unusual file names literal in output', () => {
    const names = ['space name', 'a[b]', 'a?b', 'a*b', 'a\\b', "a'b", 'line\nname', 'é😀']
    const t = createTerminal(Object.fromEntries(names.map((name) => [name, ''])))
    for (const name of names) success("realpath '" + name.replaceAll("'", "'\\''") + "'", '/' + name + '\n', t)
  })

  it('treats dash as a file name and supports the option terminator', () => {
    success('realpath - -- -e --relative-to=x', '/-\n/-e\n/--relative-to=x\n')
  })

  for (const options of ['-z', '--zero', '-ez']) {
    it(options + ' terminates every path with NUL', () => success(`realpath ${options} dir file`, '/dir\0/file\0'))
  }
})

describe('realpath existence checks precede dot-dot collapse', () => {
  for (const option of ['', '-L', '-s', '-e', '-eL', '-es', '-LP', '-sP', '--logical --physical']) {
    for (const [path, reason] of [
      ['file/child', /not a directory/iu], ['file/', /not a directory/iu],
      ['file/.', /not a directory/iu], ['file/..', /not a directory/iu], ['file/../dir', /not a directory/iu],
      ['missing/child', /no such file or directory/iu], ['missing/.', /no such file or directory/iu],
      ['missing/..', /no such file or directory/iu], ['missing/../file', /no such file or directory/iu],
    ]) {
      if (option === '-s' && path === 'missing/child') continue
      it(`${option} ${path}`, () => failure(`realpath ${option} ${path}`, reason))
    }
  }

  for (const option of ['-e', '--canonicalize-existing', '-se', '-Le']) {
    for (const path of ['missing', 'missing/', 'dir/missing']) {
      it(`${option} requires ${path}`, () => failure(`realpath ${option} ${path}`, /no such file or directory/iu))
    }
  }

  for (const option of ['-m', '--canonicalize-missing', '-sm', '-Lm', '-Pm']) {
    for (const [path, canonical] of [
      ['missing/child', '/missing/child'], ['missing/../file', '/file'], ['missing/.', '/missing'],
      ['file/child', '/file/child'], ['file/../dir', '/dir'], ['file/', '/file'],
      ['file/child/../../other/leaf', '/other/leaf'], ['missing/../../..', '/'],
    ]) it(`${option} canonicalizes ${path} without requiring directories`, () => success(`realpath ${option} ${path}`, canonical + '\n'))
  }

  for (const option of ['', '-m', '-s', '-L', '-e']) {
    it(`${option} still rejects an empty path`, () => failure(`realpath ${option} ''`, /no such file or directory/iu))
  }

  for (const options of ['-em', '-e -m', '--canonicalize-existing --canonicalize-missing']) {
    it(options + ' uses the final existence mode', () => success(`realpath ${options} file/child`, '/file/child\n'))
  }
  for (const options of ['-me', '-m -e', '--canonicalize-missing --canonicalize-existing']) {
    it(options + ' restores required existence', () => failure(`realpath ${options} missing`, /no such file or directory/iu))
  }
  // GNU has no flag for the default mode, so once -e or -m is given there is no
  // way back to it; a run that never names one is the only way to ask for it.
  for (const options of ['', '-L']) {
    it(JSON.stringify(options) + ' is the only way to ask for the default mode', () => {
      success(`realpath ${options} missing`, '/missing\n')
      failure(`realpath ${options} missing/child`, /no such file or directory/iu)
    })
  }
})

describe('realpath strip mode defers ordinary intermediate existence checks', () => {
  // CAN_NOLINKS skips ordinary intermediate names. Only a suffix requiring
  // directory traversal (notably /..) or the final lookup forces a check.
  for (const option of ['-s', '--strip', '--no-symlinks', '-Ls']) {
    for (const path of ['missing/child', 'missing/./child', 'missing/child/']) {
      it(`${option} permits ${path} in the default existence mode`, () => success(`realpath ${option} ${path}`, '/missing/child\n'))
    }
    it(option + ' still catches an existing file in a parent component', () => failure(`realpath ${option} file/missing/child`, /not a directory/iu))
    it(option + ' still validates a component before dot-dot', () => failure(`realpath ${option} missing/sub/../file`, /no such file or directory/iu))
  }
  for (const option of ['-sL', '-sP', '-se']) {
    it(option + ' restores missing-intermediate rejection', () => failure(`realpath ${option} missing/child`, /no such file or directory/iu))
  }
  it('uses the same strip canonicalization for a relative-to base', () => {
    success('realpath -s --relative-to=missing/child file', '../../file\n')
  })
})

describe('realpath relative output', () => {
  for (const [args, stdout] of [
    ['--relative-to=/ dir/child', 'dir/child\n'],
    ['--relative-to=dir dir/child', 'child\n'],
    ['--relative-to dir dir/sub/leaf', 'sub/leaf\n'],
    ['--relative-to=dir dir dir/sub ..', '.\nsub\n..\n'],
    ['--relative-to=dir/sub file other/leaf', '../../file\n../../other/leaf\n'],
    ['--relative-to=dir/sub dir/child', '../child\n'],
    ['--relative-to=dir/../other dir/child', '../dir/child\n'],
    ['--relative-to=dir --relative-to=other dir/child', '../dir/child\n'],
    ['--relative-base=dir dir/child other/leaf', 'child\n/other/leaf\n'],
    ['--relative-base dir dir dir/sub dir2/leaf', '.\nsub\n/dir2/leaf\n'],
    ['--relative-base=/ dir/child /', 'dir/child\n.\n'],
    ['--relative-base=dir --relative-to=dir/sub dir/child dir/sub/leaf other/leaf', '../child\nleaf\n/other/leaf\n'],
    ['--relative-base=dir --relative-to=other dir/child other/leaf', '/dir/child\n/other/leaf\n'],
    ['--relative-to=dir --relative-base=dir/sub dir/sub/leaf', '/dir/sub/leaf\n'],
    ['--relative-base=dir --relative-base=other dir/child other/leaf', '/dir/child\nleaf\n'],
    ['--relative-to=missing file', '../file\n'],
    ['--relative-to=file file dir/child', '.\n../dir/child\n'],
    ['--relative-base=file file dir/child', '.\n/dir/child\n'],
    ['--relative-base=missing missing dir/child', '.\n/dir/child\n'],
    ['-m --relative-to=none/sub dir/child', '../../dir/child\n'],
    ['-m --relative-base=none none/a other/leaf', 'a\n/other/leaf\n'],
    ['-z --relative-to=dir dir/child file', 'child\0../file\0'],
  ]) it(args, () => success('realpath ' + args, stdout))

  for (const option of ['--relative-to', '--relative-base']) {
    for (const [prefix, path, reason] of [
      ['', 'missing/child', /no such file or directory/iu],
      ['-q', 'missing/child', /no such file or directory/iu],
      ['-e', 'missing', /no such file or directory/iu],
      ['-eq', 'file', /not a directory/iu],
      ['', 'file/child', /not a directory/iu],
      ['', "''", /no such file or directory/iu],
    ]) it(`${prefix} ${option}=${path} fails before processing operands`, () => failure(`realpath ${prefix} ${option}=${path} dir file`, reason))
  }

  it('checks the base even when a separate relative-to would disable relative output', () => {
    failure('realpath --relative-to=other --relative-base=missing/child file', /no such file or directory/iu)
  })
})

describe('realpath failures, input ownership and unsupported options', () => {
  // GNU error() flushes preceding stdout before emitting each diagnostic.
  // https://github.com/coreutils/gnulib/blob/master/lib/error.c
  for (const [operands, stdout] of [
    ['file missing dir', '/file\nrealpath: missing: No such file or directory\n/dir\n'],
    ['missing file', 'realpath: missing: No such file or directory\n/file\n'],
  ]) {
    it(`preserves merged output order for ${operands}`, () => {
      assert.deepEqual(terminal().run(`realpath -e ${operands} 2>&1`), { ...result(stdout), exitCode: 1 })
    })
  }

  it('retains merged output in a writable file without an ordering diagnostic', () => {
    const t = createTerminal({ file: 'data' }, { mount: '/repo', writable: '/tmp/' })
    const actual = t.run('realpath -e file missing file >/tmp/out 2>&1')
    assert.deepEqual(actual, { ...result('', '/repo'), exitCode: 1 })
    success('cat /tmp/out', '/repo/file\nrealpath: missing: No such file or directory\n/repo/file\n', t, '/repo')
  })

  it('keeps successful operand output around ordinary failures', () => {
    const r = terminal().run('realpath -e dir missing file missing/child')
    assert.equal(r.stdout, '/dir\n/file\n')
    assert.equal(r.exitCode, 1)
    assert.equal(r.stderr.split('\n').filter(Boolean).length, 2)
    assert.deepEqual(r.unsupported, [])
  })

  for (const flag of ['-q', '--quiet']) {
    it(flag + ' suppresses operand errors without suppressing failure status', () => {
      const r = terminal().run(`realpath -e ${flag} missing file missing/child`)
      assert.equal(r.stdout, '/file\n')
      assert.equal(r.stderr, '')
      assert.equal(r.exitCode, 1)
      assert.deepEqual(r.unsupported, [])
    })
  }

  for (const command of ['realpath', 'realpath --', 'realpath -m', 'realpath --relative-to=dir']) {
    it(command + ' requires an operand', () => failure(command, /missing operand|usage/iu))
  }

  for (const command of ['realpath --relative-to', 'realpath --relative-base', 'realpath --zero=yes file', 'realpath --quiet= file']) {
    it(command + ' reports malformed supported options', () => {
      const r = terminal().run(command)
      assert.notEqual(r.exitCode, 0)
      assert.equal(r.stdout, '')
      assert.notEqual(r.stderr, '')
      assert.deepEqual(r.unsupported, [])
    })
  }

  // -E and --canonicalize are not GNU realpath options: GNU rejects the first
  // outright and calls the second an ambiguous prefix.
  for (const flag of ['-f', '-n', '-r', '-E', '--canonicalize', '--unknown', '--relative', '--relative-t=dir', '--canonicalize-exis', '--strip-slashes']) {
    it(flag + ' remains diagnosed when stderr is hidden', () => {
      const r = terminal().run(`realpath ${flag} file 2>/dev/null | cat`)
      assert.equal(r.stdout, '')
      assert.equal(r.stderr, '')
      assert.equal(r.unsupported.length, 1)
      assert.equal(r.unsupported[0].kind, 'option')
      assert.equal(r.unsupported[0].command, 'realpath')
      assert.equal(r.unsupported[0].detail, flag.split('=')[0])
    })
  }

  for (const command of ['realpath file', 'x=$(realpath file); echo "$x"', 'realpath -', 'realpath --relative-to=dir file']) {
    it(command + ' leaves inherited input available to the next reader', () => {
      const path = command.endsWith(' -') ? '/-' : command.includes('--relative-to') ? '../file' : '/file'
      success(`{ ${command}; cat; } <input`, path + '\nunconsumed\n')
    })
  }

  it('does not consume input when an operand fails', () => {
    const r = terminal().run('{ realpath -e missing; cat; } <input')
    assert.equal(r.stdout, 'unconsumed\n')
    assert.equal(r.exitCode, 0)
    assert.match(r.stderr, /no such file or directory/iu)
  })

  it('preserves the enclosing xargs read guard when output would modify its arguments', () => {
    const t = createTerminal({}, { mount: '/repo', writable: '/tmp/' })
    t.run("printf '/tmp/args\\n' >/tmp/args")
    const actual = t.run('xargs realpath </tmp/args >>/tmp/args 2>/dev/null | cat')
    assert.equal(actual.stdout, '')
    assert.equal(actual.stderr, '')
    assert.equal(actual.exitCode, 0)
    assert.equal(actual.unsupported.length, 1)
    assert.equal(actual.unsupported[0].command, 'xargs')
    assert.equal(actual.unsupported[0].detail, 'streaming self-output')
    success('cat /tmp/args', '/tmp/args\n', t, '/repo')
  })
})

describe('realpath mount paths and missing-path narration', () => {
  const mounted = () => createTerminal({ file: '', 'dir/child': '', 'sub/keep': '' }, { mount: '/repo', cwd: '/repo/sub', home: '/repo/dir', writable: '/tmp/' })

  it('uses configured cwd and shell tilde expansion', () => {
    success('realpath . ../file ~ ~/child /repo/file', '/repo/sub\n/repo/file\n/repo/dir\n/repo/dir/child\n/repo/file\n', mounted(), '/repo/sub')
  })

  it('does not expand a quoted tilde a second time', () => {
    success("realpath '~'", '/repo/sub/~\n', mounted(), '/repo/sub')
  })

  it('accepts newly written overlay paths', () => {
    const t = mounted()
    t.run('printf text >/tmp/file')
    success('realpath -e /tmp/file /tmp', '/tmp/file\n/tmp\n', t, '/repo/sub')
  })

  it('does not decode file contents to resolve binary overlay paths', () => {
    const t = mounted()
    t.run("printf '/w==' | base64 -d >/tmp/binary")
    success('realpath -e /tmp/binary', '/tmp/binary\n', t, '/repo/sub')
  })

  for (const option of ['-e', '-eq']) {
    it(option + ' narrates a relative path that exists under the mount', () => {
      const r = mounted().run(`realpath ${option} file`)
      assert.equal(r.exitCode, 1)
      assert.deepEqual(r.unsupported, [])
      assert.deepEqual(r.notes, ['realpath: relative path "file" was not found from cwd "/repo/sub". A file exists at "/repo/file".'])
    })
  }

  it('narrates a failed intermediate directory lookup', () => {
    const r = mounted().run('realpath dir/child')
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.notes, ['realpath: relative path "dir/child" was not found from cwd "/repo/sub". A file exists at "/repo/dir/child".'])
  })

  it('does not narrate a successful missing final component', () => {
    success('realpath file', '/repo/sub/file\n', mounted(), '/repo/sub')
  })

  it('narrates failed relative-to setup', () => {
    const r = mounted().run('realpath -e --relative-to=dir keep')
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.notes, ['realpath: relative path "dir" was not found from cwd "/repo/sub". A dir exists at "/repo/dir".'])
  })

  it('narrates the mounted alternative for an absolute operand, without naming a cwd it did not use', () => {
    const r = mounted().run('realpath -e /file')
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.notes, ['realpath: absolute path "/file" was not found. A file exists at "/repo/file".'])
  })

  it('narrates the home alternative for an absolute operand', () => {
    const r = mounted().run('realpath -e /child')
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.notes, ['realpath: absolute path "/child" was not found. A file exists at "/repo/dir/child".'])
  })
})

describe('realpath quotes an operand only where a shell would need it', () => {
  // GNU realpath uses quotearg's shell-escape style, not the always-quoting
  // quoteaf that `du`, `cp` and `rm` print. `#` and `~` are bare only away from
  // the front, where a shell would read them as a comment and a tilde.
  for (const [name, shown] of [
    ['missing', 'missing'], ['dir/missing', 'dir/missing'], ['a#b', 'a#b'], ['a~b', 'a~b'],
    ['a%b,c+d@e]f{g}h', 'a%b,c+d@e]f{g}h'],
    ['#ab', "'#ab'"], ['~ab', "'~ab'"], ['', "''"], ['a b', "'a b'"], ['a:b', "'a:b'"],
    ['a|b', "'a|b'"], ['a$b', "'a$b'"], ['a*b', "'a*b'"], ['a[b', "'a[b'"], ['a\\b', "'a\\b'"],
    ["a'b", '"a\'b"'],
  ]) {
    it(JSON.stringify(name), () => {
      const r = terminal().run(`LC_ALL=C realpath -e -- '${name.replaceAll("'", "'\\''")}'`)
      assert.equal(r.stderr, `realpath: ${shown}: No such file or directory\n`)
      assert.equal(r.exitCode, 1)
      assert.deepEqual(r.unsupported, [])
    })
  }

  it('escapes nonprinting bytes under the C locale', () => {
    const r = terminal().run("LC_ALL=C realpath -e -- 'a\u00E9b'")
    assert.equal(r.stderr, "realpath: 'a'$'\\303\\251''b': No such file or directory\n")
  })
})
