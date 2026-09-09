import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU base64 preserves bytes decoded before the first invalid quartet.
// GNU rm uses quoteaf for both successful removals and operand errors.
// https://github.com/coreutils/coreutils/blob/v9.11/src/basenc.c
// https://github.com/coreutils/gnulib/blob/master/lib/base64.c
// https://github.com/coreutils/coreutils/blob/v9.11/src/remove.c
// https://github.com/coreutils/gnulib/blob/master/lib/quotearg.c
const result = (stdout = '', exitCode = 0, stderr = '', unsupported = []) => ({ stdout, stderr, exitCode, cwd: '/', unsupported })
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const writable = (files = {}) => createTerminal(files, { mount: '/src/', writable: '/tmp/' })

describe('base64 Unicode cannot silently change input bytes', () => {
  for (const text of ['\uD800', '\uDC00', 'before\uD800after', '😃\uDC00', '\uD800😃', '\uDC00\uD800']) {
    it(`rejects unpaired surrogates: ${JSON.stringify(text)}`, () => {
      const t = createTerminal({ input: text })
      const failure = t.run('base64 input')
      assert.equal(failure.stdout, '')
      assert.equal(failure.exitCode, 1)
      assert.deepEqual(failure.unsupported.map(({ detail }) => detail), ['unpaired surrogate'])
      assert.deepEqual(t.run('cat input | base64 2>/dev/null | cat'), result('', 0, '', failure.unsupported))
    })
  }
  it('distinguishes an actual replacement character from an invalid surrogate', () => {
    assert.deepEqual(createTerminal({ input: '\uFFFD' }).run('base64 input'), result('77+9\n'))
  })
  it('preserves valid pairs at both ends of ordinary text', () => {
    const t = createTerminal({ input: '😃hello😃' })
    assert.deepEqual(t.run('base64 input | base64 -d'), result('😃hello😃'))
  })
  it('reassembles UTF-8 before decoding text, even across many padded blocks', () => {
    const t = createTerminal({ input: '8A==nw==mA==gw==' })
    assert.deepEqual(t.run('base64 -d input'), result('😃'))
  })
  for (const encoded of ['wA==gA==', '4A==gA==gA==', '7Q==oA==gA==', '9A==kA==gA==gA==', 'gA==']) {
    it(`rejects invalid UTF-8 ${encoded}`, () => {
      const actual = createTerminal({ input: encoded }).run('base64 -d input')
      assert.equal(actual.stdout, '')
      assert.equal(actual.exitCode, 1)
      assert.deepEqual(actual.unsupported.map(({ detail }) => detail), ['partial UTF-8 byte sequence'])
    })
  }
})

describe('base64 malformed streams stop at the first invalid group', () => {
  const cases = [
    ['Zg==Yg==Zm9v', 'fbfoo', 0], ['Zg==Zg', 'ff', 0], ['Zg==Zg=\n', 'ff', 1],
    ['Zg==!Zg==', 'f', 1], ['Zg==Zm9v====', 'ffoo', 1], ['Zg==Zm9v=Zg==', 'ffoo', 1],
    ['Zm9vYmFyZ', 'foobar', 1], ['Zm9vYmFyZg=', 'foobarf', 1],
    ['Zm9vYmFyZh==', 'foobarf', 1], ['Zm9vYmFyZg!Zg==', 'foobarf', 1],
    ['Zm9vYmFyZm8!Zg==', 'foobarfo', 1], ['Zm9vYmFyZ!Zg==', 'foobar', 1],
    ['Zg=\t=', 'f', 1], ['Zg==\u00A0', 'f', 1], ['Zg==\u2028', 'f', 1],
    ['\r\n', '', 1], ['\n \n', '', 1], ['Z\nf\n=\n=', 'e', 1],
  ]
  for (const [input, stdout, exitCode] of cases) {
    it(JSON.stringify(input), () => {
      assert.deepEqual(createTerminal({ input }).run('base64 -d input'), result(stdout, exitCode, exitCode ? 'base64: invalid input\n' : ''))
    })
  }
  it('ignores arbitrary nonalphabet characters only when requested', () => {
    const t = createTerminal({ input: 'Zg=\t=\u2028Zg\0\u00A0' })
    assert.deepEqual(t.run('base64 -di input'), result('ff'))
  })
  it('retains all preceding output before a late malformed group', () => {
    const prefix = 'Zm9v'.repeat(20_000)
    const t = createTerminal({ input: prefix + 'Zg=' })
    assert.deepEqual(t.run('base64 -d input'), result('foo'.repeat(20_000) + 'f', 1, 'base64: invalid input\n'))
  })
})

describe('base64 descriptor and option boundaries', () => {
  for (const binary of ['/usr/bin/base64', '/bin/base64', '/usr/local/bin/base64']) {
    it(binary, () => assert.deepEqual(createTerminal({ input: 'foo' }).run(`${binary} -w0 input`), result('Zm9v')))
  }
  it('distinguishes option values from operands and rejects malformed earlier values', () => {
    const t = createTerminal({ '-w': 'foo', '0': 'bar' })
    assert.deepEqual(t.run('base64 -- -w'), result('Zm9v\n'))
    assert.deepEqual(t.run('base64 -w0 0'), result('YmFy'))
    assert.deepEqual(t.run('base64 -wno --wrap=0 0'), result('', 1, 'base64: invalid wrap size: no\n'))
  })
  it('consumes shared stdin once and reopens regular /dev/stdin from the start', () => {
    const t = createTerminal({ input: 'foo' })
    assert.deepEqual(t.run('cat input | { base64 -w0; base64 -w0; }'), result('Zm9v'))
    assert.deepEqual(t.run('{ base64 -w0; base64 -w0 /dev/stdin; } <input'), result('Zm9vZm9v'))
  })
  it('does not consume input when option parsing fails', () => {
    const t = createTerminal({ input: 'foo' })
    const actual = t.run('cat input | { base64 --unknown 2>/dev/null; cat; }')
    assert.equal(actual.stdout, 'foo')
    assert.equal(actual.exitCode, 0)
    assert.deepEqual(actual.unsupported.map(({ detail }) => detail), ['--unknown'])
  })
  it('preserves partial output and ordinary errors in separate files', () => {
    const t = writable({ input: 'Zm9v!' })
    assert.deepEqual(t.run('base64 -d /src/input >/tmp/out 2>/tmp/error'), result('', 1))
    assert.deepEqual(t.run('cat /tmp/out /tmp/error'), result('foobase64: invalid input\n'))
  })
  it('retains a recoverable invalid-input prefix through a successful pipeline', () => {
    assert.deepEqual(createTerminal({ input: 'Zm9v!' }).run('base64 -d input 2>/dev/null | cat'), result('foo'))
  })
  it('does not consume a snapshot when output appends to its input', () => {
    const t = writable({ input: 'foo' })
    t.run('cat /src/input >/tmp/input')
    const actual = t.run('base64 /tmp/input >>/tmp/input')
    assert.equal(actual.stdout, '')
    assert.equal(actual.exitCode, 1)
    assert.deepEqual(actual.unsupported.map(({ detail }) => detail), ['streaming self-output'])
    assert.deepEqual(t.run('cat /tmp/input'), result('foo'))
  })
})

describe('rm quotes complete filenames in success and error output', () => {
  const cases = [
    ["a'b", '"/tmp/a\'b"'],
    ["a'b$c", "'/tmp/a'\\''b$c'"],
    ['a\nb', "'/tmp/a'$'\\n''b'"],
    ['a\n\tb', "'/tmp/a'$'\\n\\t''b'"],
    ["a\n'b", "'/tmp/a'$'\\n'\\''b'"],
    ['a\u0001\u007Fb', "'/tmp/a'$'\\001\\177''b'"],
    ['é\nb', "'/tmp/é'$'\\n''b'"],
    ['a\\b', "'/tmp/a\\b'"],
    ['a"b', '\'/tmp/a"b\''],
    ['a\r\fb', "'/tmp/a'$'\\r\\f''b'"],
  ]
  for (const [name, shown] of cases) {
    it(JSON.stringify(name), () => {
      const t = writable()
      const path = quote('/tmp/' + name)
      assert.deepEqual(t.run(`>${path}; rm -v ${path}`), result(`removed ${shown}\n`))
      assert.deepEqual(t.run(`rm ${path}`), result('', 1, `rm: cannot remove ${shown}: No such file or directory\n`))
    })
  }
  it('uses byte escapes for Unicode under the C locale', () => {
    const t = writable()
    assert.deepEqual(t.run("echo data >/tmp/é; LC_ALL=C rm -v /tmp/é"), result("removed '/tmp/'$'\\303\\251'\n"))
  })
  it('diagnoses nonprinting Unicode quoting before deleting a verbose operand', () => {
    const t = writable()
    const path = quote('/tmp/a\u2028b')
    t.run(`>${path}`)
    const actual = t.run(`rm -v ${path} 2>/dev/null | cat`)
    assert.equal(actual.stdout, '')
    assert.equal(actual.exitCode, 0)
    assert.deepEqual(actual.unsupported.map(({ detail }) => detail), ['filename quoting'])
    assert.deepEqual(t.run(`test -f ${path}`), result())
    assert.deepEqual(t.run(`rm ${path}`), result())
  })
})

describe('rm effects respect descriptor and input lifetime', () => {
  it('does not consume inherited stdin', () => {
    const t = writable({ input: 'foo' })
    assert.deepEqual(t.run('>/tmp/file; cat /src/input | { rm /tmp/file; cat; }'), result('foo'))
  })
  it('does not resurrect a removed diagnostic target', () => {
    const t = writable()
    assert.deepEqual(t.run('rm /tmp/log /tmp/missing 2>/tmp/log; test -f /tmp/log'), result('', 1))
  })
  it('supports recreated filenames while the previous output inode remains open', () => {
    const t = writable()
    assert.deepEqual(t.run('{ rm /tmp/log; printf new >/tmp/log; echo old; } >/tmp/log; cat /tmp/log'), result('new'))
  })
  it('honors the option terminator for filenames named after flags', () => {
    const t = writable()
    assert.deepEqual(t.run('>/tmp/-f; >/tmp/--verbose; rm -- /tmp/-f /tmp/--verbose; ls /tmp'), result())
  })
  it('unknown option modes cannot partially delete earlier operands', () => {
    const t = writable()
    t.run('>/tmp/file')
    const actual = t.run('rm /tmp/file -iv 2>/dev/null | cat')
    assert.deepEqual(actual.unsupported.map(({ detail }) => detail), ['-i'])
    assert.deepEqual(t.run('test -f /tmp/file'), result())
  })
})
