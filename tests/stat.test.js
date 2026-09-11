import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { createFs } from '../src/fs.js'
import { writableFs } from '../src/writable.js'
import { stat } from '../src/commands/stat.js'

// Format and escape semantics from GNU stat, with unavailable metadata rejected.
// https://www.gnu.org/software/coreutils/manual/html_node/stat-invocation.html
const sources = { a: 'abc', empty: '', 'dir/file': 'é😀', 'é😀': 'unicode', 'a b': 'space' }
const result = (stdout = '', exitCode = 0, stderr = '', cwd = '/') => ({ stdout, stderr, exitCode, cwd, notes: [], unsupported: [] })
const run = (command) => createTerminal(sources).run(command)

describe('stat renders known file properties', () => {
  for (const option of ['-c', '--format']) {
    it(option, () => assert.deepEqual(run(`stat ${option} '%n: %s %F' a empty dir/file`), result('a: 3 regular file\nempty: 0 regular empty file\ndir/file: 6 regular file\n')))
  }
  it('supports attached format arguments and flags after operands', () => {
    assert.deepEqual(run('stat a -c%s'), result('3\n'))
    assert.deepEqual(run('stat --format=%s a'), result('3\n'))
  })
  it('names directories without inventing byte sizes', () => assert.deepEqual(run("stat -c '%n %F' dir /"), result('dir directory\n/ directory\n')))
  it('preserves original name spelling and counts UTF-8 bytes', () => {
    assert.deepEqual(run("stat -c '%n:%s' ./dir//file dir/../a 'a b'"), result('./dir//file:6\ndir/../a:3\na b:5\n'))
  })
  for (const option of ['-L', '--dereference', '-t', '--terse', '--cached=always', '--cached=never', '--cached=default', '--cached=a', '--cached=n', '--cached=d']) {
    it(`explicit format ${option}`, () => assert.deepEqual(run(`stat ${option} -c%s a`), result('3\n')))
  }
  it('empty format emits the per-operand newline', () => assert.deepEqual(run("stat -c '' a empty"), result('\n\n')))
  it('empty printf format has no implicit output', () => assert.deepEqual(run("stat --printf='' a empty"), result()))
  it('format and printf options replace both the format and escape mode', () => {
    assert.deepEqual(run("stat --printf='wrong' -c '%s\\n' a"), result('3\\n\n'))
    assert.deepEqual(run("stat -c wrong --printf='%s\\n' a"), result('3\n'))
  })
  it('does not consume piped standard input', () => assert.deepEqual(run("printf 'input\\n' | { stat -c%s a; cat; }"), result('3\ninput\n')))
  it('repeats duplicate operands', () => assert.deepEqual(run('stat -c%s a a'), result('3\n3\n')))
  it('permits a literal dash-prefixed filename after --', () => {
    assert.deepEqual(createTerminal({ '-name': 'abc' }).run('stat -c%s -- -name'), result('3\n'))
  })
})

describe('stat format fields and escapes', () => {
  for (const [format, stdout] of [
    ['%5s', '    3\n'], ['%-5s', '3    \n'], ['%05s', '00003\n'], ['%05.3s', '  003\n'], ['%+s', '3\n'],
    ['%# +05s', '00003\n'], ['%-05s', '3    \n'], ['%.s', '3\n'],
    ['%.0s', '3\n'], ['%5n', '    a\n'], ['%-5n', 'a    \n'], ['%05n', '    a\n'], ['%.0n', '\n'],
    ['%# +05n', '    a\n'], ['%-08.3F', 'reg     \n'],
    ['%.7F', 'regular\n'], ['%%:%s:%', '%:3:%\n'],
  ]) {
    it(format, () => assert.deepEqual(run(`stat -c '${format}' a`), result(stdout)))
  }
  it('zero precision suppresses a numeric zero', () => assert.deepEqual(run("stat -c 'size=%.0s.' empty"), result('size=.\n')))
  it('string widths and precision are in bytes', () => {
    assert.deepEqual(run("stat -c '%8n' 'é😀'"), result('  é😀\n'))
    assert.deepEqual(run("stat -c '%.2n' 'é😀'"), result('é\n'))
  })
  for (const [format, stdout] of [
    ['%n\\n%s\\t', 'a\n3\t'], ['\\a\\b\\e\\f\\r\\v', '\u0007\b\u001B\f\r\v'],
    ['\\\\\\"', '\\"'], ['\\101\\x42\\103', 'ABC'], ['\\0%s\\000', '\u00003\0'],
    ['\\xC3\\xA9', 'é'], ['\\303\\251', 'é'], ['\\045s', '%s'], ['\\777', null],
  ]) {
    it(`printf ${format}`, () => {
      const actual = run(`stat --printf='${format}' a`)
      if (stdout === null) {
        assert.equal(actual.exitCode, 1)
        assert.equal(actual.stdout, '')
        assert.equal(actual.unsupported.length, 1)
      } else assert.deepEqual(actual, result(stdout))
    })
  }
  it('formats adjacent byte fragments before UTF-8 validation', () => assert.deepEqual(run("stat --printf='%.1n\\xA9' 'é😀'"), result('é')))
  it('limits octal escapes to three digits and hexadecimal escapes to two', () => {
    assert.deepEqual(run("stat --printf='\\1011:\\x412:%%s' a"), result('A1:A2:%s'))
  })
  it('emits NUL separators and literal filename line breaks', () => {
    assert.deepEqual(createTerminal({ 'a\nb': 'x', c: '' }).run("stat --printf='%n\\0%s\\0' 'a\nb' c"), result('a\nb\u00001\u0000c\u00000\u0000'))
  })
  it('preserves backslashes literally without --printf', () => assert.deepEqual(run("stat -c '%s\\n\\t' a"), result('3\\n\\t\n')))
  it('returns a diagnosed error for a partial UTF-8 field', () => {
    const actual = run("stat -c '%.1n' 'é😀'")
    assert.equal(actual.exitCode, 1)
    assert.equal(actual.stdout, '')
    assert.equal(actual.unsupported.length, 1)
  })
})

describe('stat reports unavailable metadata and unsupported syntax', () => {
  for (const command of ['stat a', 'stat -t a', 'stat --terse a', "stat -c '%s' dir"]) {
    it(command, () => {
      const actual = run(command + ' 2>/dev/null | cat')
      assert.equal(actual.stdout, '')
      assert.equal(actual.stderr, '')
      assert.equal(actual.unsupported.length, 1)
      assert.equal(actual.unsupported[0].command, 'stat')
    })
  }
  for (const field of [...'aAbBCdDfghiGmNoOrRtTuUwWxXyYzZ', 'Hd', 'Ld', 'Hr', 'Lr', 'Qn', '?']) {
    it(`diagnoses %${field}`, () => {
      const actual = run(`stat -c '%${field}' a 2>/dev/null | cat`)
      assert.equal(actual.stdout, '')
      assert.equal(actual.unsupported.length, 1)
      assert.equal(actual.unsupported[0].kind, 'feature')
    })
  }
  for (const option of ['-f', '--file-system', '--bad', '-x']) {
    it(`diagnoses ${option}`, () => {
      const actual = run(`stat ${option} -c%s a 2>/dev/null | cat`)
      assert.equal(actual.unsupported[0].kind, 'option')
    })
  }
  for (const format of ['\\c', '\\u0041', '\\q', '\\x', '\\']) {
    it(`diagnoses unsupported printf escape ${format}`, () => {
      const actual = run(`stat --printf='${format}' a 2>/dev/null | cat`)
      assert.equal(actual.unsupported.length, 1)
    })
  }
  for (const format of ['%*s', '%1000000000s', "%'s", '%1$s']) {
    it(`diagnoses unsupported field ${format}`, () => {
      const quoted = "'" + format.replaceAll("'", "'\\''") + "'"
      const actual = run(`stat -c ${quoted} a 2>/dev/null | cat`)
      assert.ok(actual.unsupported.length >= 1)
      assert.equal(actual.unsupported[0].command, 'stat')
    })
  }
  it('retains a directory-size gap when a later file succeeds', () => {
    const actual = run('stat -c%s dir a')
    assert.equal(actual.exitCode, 1)
    assert.equal(actual.stdout, '3\n')
    assert.equal(actual.unsupported[0].detail, 'directory byte size')
  })
  it('diagnoses stdin metadata instead of reporting buffered string length', () => {
    const actual = run("printf xyz | { stat -c%s -; cat; }")
    assert.equal(actual.stdout, 'xyz')
    assert.equal(actual.unsupported[0].detail, 'standard input metadata')
  })
  it('diagnoses ambiguous source paths', () => {
    const actual = createTerminal({ a: 'x', 'a/b': 'y' }).run('stat -c%F a')
    assert.equal(actual.unsupported[0].detail, 'ambiguous file type')
  })
})

describe('stat errors, mounts, and writable metadata', () => {
  it('continues after missing files', () => {
    assert.deepEqual(run('stat -c%s missing a'), result('3\n', 1, "stat: cannot stat 'missing': No such file or directory\n"))
  })
  it('retains operand event order under merged descriptors', () => {
    assert.deepEqual(run('stat -c%s a missing empty 2>&1'), result("3\nstat: cannot stat 'missing': No such file or directory\n0\n", 1))
  })
  for (const name of ['a/../empty', 'missing/../a', 'a/']) {
    it(`validates intermediate components ${name}`, () => {
      const actual = run('stat -c%s ' + name)
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.stdout, '')
      assert.deepEqual(actual.unsupported, [])
    })
  }
  for (const command of ['stat', 'stat -c%s', 'stat --cached=wrong -c%s a', 'stat -c']) {
    it(`invalid invocation ${command}`, () => {
      const actual = run(command)
      assert.equal(actual.exitCode, 1)
      assert.equal(actual.stdout, '')
    })
  }
  it('adds a relative-path note from a changed cwd', () => {
    const actual = createTerminal(sources, { mount: '/repo' }).run('cd dir; stat -c%s a')
    assert.equal(actual.exitCode, 1)
    assert.deepEqual(actual.notes, ['stat: relative path "a" was not found from cwd "/repo/dir". A file exists at "/repo/a".'])
  })
  it('reflects in-memory writes, appends, and replacements', () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    assert.deepEqual(terminal.run("printf é >/tmp/file; stat -c%s /tmp/file; printf 😀 >>/tmp/file; stat -c%s /tmp/file; printf a >/tmp/file; stat -c%s /tmp/file"), result('2\n6\n1\n', 0, '', '/src'))
  })
  it('reflects empty files, in-place replacement, and removal in the type field', () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    const actual = terminal.run(": >/tmp/file; stat -c%F /tmp/file; printf x >/tmp/file; sed -i.bak 's/x/xx/' /tmp/file; stat -c '%s %F' /tmp/file /tmp/file.bak; rm /tmp/file; stat -c%F /tmp/file")
    assert.deepEqual(actual, result('regular empty file\n2 regular file\n1 regular file\n', 1, "stat: cannot stat '/tmp/file': No such file or directory\n", '/src'))
  })
  it('measures invalid UTF-8 overlay bytes without decoding them', () => {
    const fs = writableFs(createFs({}, '/src'))
    const first = fs.openWritable('/', '/tmp/file'), second = fs.openWritable('/', '/tmp/file')
    first.write('é'); second.write('X')
    assert.throws(() => fs.readFile('/tmp/file'), /UTF-8/u)
    const ctx = { fs, cwd: '/', vars: new Map(), notes: new Set(), outputFds: {}, unsupported: { add() {} } }
    assert.equal(stat('', ['-c', '%s %F', '/tmp/file'], ctx).stdout, '2 regular file\n')
  })
  it('diagnoses unpaired source surrogates instead of measuring replacement bytes', () => {
    const actual = createTerminal({ file: '\uD800' }).run('stat -c%s file')
    assert.equal(actual.exitCode, 1)
    assert.equal(actual.stdout, '')
    assert.equal(actual.unsupported.length, 1)
  })
  it('diagnoses buffered output that shares a measured file', () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    const actual = terminal.run('stat -c%s /tmp/file /tmp/file >/tmp/file')
    assert.equal(actual.exitCode, 1)
    assert.equal(actual.unsupported[0].detail, 'metadata output overlap')
  })
  it('allows filename-only output to share the named file', () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    assert.deepEqual(terminal.run('stat -c%n /tmp/file >/tmp/file; cat /tmp/file'), result('/tmp/file\n', 0, '', '/src'))
  })
  it('detects metadata overlap through a renamed backup and nested dispatch', () => {
    const terminal = createTerminal({}, { mount: '/src', writable: '/tmp/' })
    const actual = terminal.run("printf abc >/tmp/file; { sed -i.bak 's/a/A/' /tmp/file; printf /tmp/file.bak | xargs stat -c%s; } >>/tmp/file")
    assert.equal(actual.exitCode, 123)
    assert.equal(actual.unsupported[0].detail, 'metadata output overlap')
    assert.equal(terminal.run('cat /tmp/file /tmp/file.bak').stdout, 'Abcabc')
  })
})
