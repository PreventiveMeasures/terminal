import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// RFC 4648 section 10 supplies the short standard vectors. GNU's option,
// auto-padding, and partial-output rules come from basenc.c and base64.c.
// https://www.rfc-editor.org/rfc/rfc4648#section-10
// https://github.com/coreutils/coreutils/blob/v9.11/src/basenc.c
// https://github.com/coreutils/gnulib/blob/master/lib/base64.c
const expected = (stdout = '', exitCode = 0, stderr = '', unsupported = []) => ({ stdout, stderr, exitCode, cwd: '/', notes: [], unsupported })
const vectors = [
  ['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy'],
  ['é', 'w6k='], ['😃', '8J+Ygw=='], ['a\0b', 'YQBi'], ['\uFEFFx', '77u/eA=='],
]

describe('base64 standard text and byte encoding', () => {
  for (const [text, encoded] of vectors) {
    it(JSON.stringify(text), () => {
      const t = createTerminal({ input: text, encoded })
      assert.deepEqual(t.run('base64 input'), expected(encoded ? encoded + '\n' : ''))
      assert.deepEqual(t.run('base64 -w0 input'), expected(encoded))
      assert.deepEqual(t.run('base64 -d encoded'), expected(text))
    })
  }
  it('accepts stdin, explicit dash, redirections, and the long decode alias', () => {
    const t = createTerminal({ input: 'foo', encoded: 'Zm9v' })
    for (const command of ['cat input | base64', 'cat input | base64 -', 'base64 <input']) {
      assert.deepEqual(t.run(command), expected('Zm9v\n'))
    }
    assert.deepEqual(t.run('base64 --decode encoded'), expected('foo'))
    assert.deepEqual(t.run('base64 input | base64 --decode'), expected('foo'))
  })
  it('processes long inputs without depending on a function argument limit', () => {
    const text = 'foo'.repeat(100_000)
    const t = createTerminal({ input: text })
    assert.deepEqual(t.run('base64 -w0 input'), expected('Zm9v'.repeat(100_000)))
    assert.deepEqual(t.run('base64 input | base64 -d'), expected(text))
  })
  it('stores encoded and decoded files entirely in the virtual filesystem', () => {
    const t = createTerminal({ input: '{"ok":true}\n' }, { mount: '/src/', writable: '/tmp/' })
    assert.deepEqual(t.run('base64 /src/input >/tmp/data; base64 -d /tmp/data >/tmp/plain; cat /tmp/plain'), expected('{"ok":true}\n'))
  })
})

describe('base64 wrapping options', () => {
  const t = () => createTerminal({ input: 'a'.repeat(58), short: 'foo' })
  it('wraps after 76 columns by default', () => {
    assert.deepEqual(t().run('base64 input'), expected('YWFh'.repeat(19) + '\nYQ==\n'))
  })
  it('does not insert an extra blank line at an exact wrap boundary', () => {
    assert.deepEqual(createTerminal({ input: 'a'.repeat(57) }).run('base64 input'), expected('YWFh'.repeat(19) + '\n'))
  })
  for (const option of ['-w2', '-w 2', '--wrap=2', '--wrap 2', "-w ' +002'"]) {
    it(option, () => assert.deepEqual(t().run(`base64 ${option} short`), expected('Zm\n9v\n')))
  }
  for (const option of ['-w0', '--wrap=0', '-w -0', '-w 18446744073709551616']) {
    it(option, () => assert.deepEqual(t().run(`base64 ${option} short`), expected('Zm9v')))
  }
  it('a representable huge width still terminates its final line', () => {
    assert.deepEqual(t().run('base64 -w9223372036854775807 short'), expected('Zm9v\n'))
  })
  it('applies the last wrap alias regardless of spelling', () => {
    assert.deepEqual(t().run('base64 -w1 --wrap=0 short'), expected('Zm9v'))
    assert.deepEqual(t().run('base64 --wrap=0 -w1 short'), expected('Z\nm\n9\nv\n'))
  })
  it('validates but otherwise ignores wrap during decoding', () => {
    assert.deepEqual(createTerminal({ input: 'Zm9v' }).run('base64 -dw1 input'), expected('foo'))
  })
  for (const value of ['-1', '1.5', '2k', '2 ', 'no', '']) {
    it(`rejects wrap ${JSON.stringify(value)}`, () => {
      assert.deepEqual(t().run(`base64 --wrap='${value}' short`), expected('', 1, `base64: invalid wrap size: ${value}\n`))
    })
  }
})

describe('base64 decoder validates padding and preserves decoded prefixes', () => {
  const valid = [
    ['YQ', 'a'], ['YWI', 'ab'], ['YQ==Yg==', 'ab'], ['YQ==YmM=', 'abc'],
    ['YQ==YmM', 'abc'], ['Y\nQ=\n=\n', 'a'], ['\n\n', ''],
  ]
  for (const [input, stdout] of valid) {
    it(JSON.stringify(input), () => assert.deepEqual(createTerminal({ input }).run('base64 -d input'), expected(stdout)))
  }
  const invalid = [
    ['Y', ''], ['=', ''], ['YQ=', 'a'], ['YQ=\n', 'a'], ['YQ===', 'a'],
    ['YQ!ignored', 'a'], ['YWI!ignored', 'ab'], ['Y!Q=', ''],
    ['Zm9v!YmFy', 'foo'], ['YQ==?', 'a'], ['YQ==Y', 'a'],
    ['YQ==YQ=', 'aa'], ['YR==', 'a'], ['YR', 'a'], ['YWJ=', 'ab'],
    ['Y Q==', ''], ['YQ ==', 'a'], ['YQ==\r\n', 'a'], ['\tYQ==', ''],
    ['YQ==\0', 'a'], ['YQ==é', 'a'], ['YQ--', 'a'],
  ]
  for (const [input, stdout] of invalid) {
    it(`invalid ${JSON.stringify(input)}`, () => {
      assert.deepEqual(createTerminal({ input }).run('base64 -d input'), expected(stdout, 1, 'base64: invalid input\n'))
    })
  }
  it('retains stdout before stderr when their descriptors are combined', () => {
    assert.deepEqual(createTerminal({ input: 'Zm9v!' }).run('base64 -d input 2>&1'), expected('foobase64: invalid input\n', 1))
  })
  for (const option of ['-di', '-d -i', '--decode --ignore-garbage']) {
    it(option, () => {
      assert.deepEqual(createTerminal({ input: 'Y\t Q!\0=é=\r\n' }).run(`base64 ${option} input`), expected('a'))
    })
  }
  it('ignore-garbage does not discard padding or fix partial padding', () => {
    assert.deepEqual(createTerminal({ input: 'YQ=!\n' }).run('base64 -di input'), expected('a', 1, 'base64: invalid input\n'))
  })
  it('ignore-garbage has no effect while encoding', () => {
    assert.deepEqual(createTerminal({ input: 'foo' }).run('base64 -i input'), expected('Zm9v\n'))
  })
})

describe('base64 input and diagnostic errors', () => {
  for (const command of ['base64 missing', 'base64 -d missing', 'base64 dir']) {
    it(command, () => {
      const result = createTerminal({ 'dir/file': 'foo' }).run(command)
      assert.equal(result.exitCode, 1)
      assert.equal(result.stdout, '')
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
    })
  }
  it('does not silently concatenate multiple file operands', () => {
    assert.deepEqual(createTerminal({ first: 'foo', second: 'bar' }).run('base64 first second'), expected('', 1, 'base64: extra operand: second\n'))
  })
  it('honors -- for an option-shaped filename', () => {
    assert.deepEqual(createTerminal({ '-d': 'foo' }).run('base64 -- -d'), expected('Zm9v\n'))
  })
  for (const option of ['--unknown', '--base64url', '-u']) {
    it(option, () => {
      const message = `base64: unknown option: ${option}`
      const unsupported = [{ kind: 'option', command: 'base64', detail: option, message }]
      const t = createTerminal({ input: 'foo' })
      assert.deepEqual(t.run(`base64 ${option} input`), expected('', 1, message + '\n', unsupported))
      assert.deepEqual(t.run(`base64 ${option} input 2>/dev/null | cat`), expected('', 0, '', unsupported))
    })
  }
  for (const encoded of ['/w==', 'w6k=8A==', '7aCA', 'Yf8=']) {
    it(`reports unrepresentable UTF-8 from ${encoded}`, () => {
      const t = createTerminal({ encoded })
      const result = t.run('base64 -d encoded')
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 1)
      assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['partial UTF-8 byte sequence'])
      assert.deepEqual(t.run('base64 -d encoded 2>/dev/null | cat'), expected('', 0, '', result.unsupported))
    })
  }
  it('completes a UTF-8 character across separately padded blocks', () => {
    assert.deepEqual(createTerminal({ encoded: 'ww==qQ==' }).run('base64 -d encoded'), expected('é'))
  })
})

describe('base64 repeated decoding keeps each result independent', () => {
  it('does not retain bytes or errors from a previous longer decode', () => {
    const t = createTerminal({ long: 'AAEC'.repeat(4096), partial: 'YQ==!', short: 'AQ==', empty: '' })
    assert.deepEqual(t.run('base64 -d long'), expected('\0\u0001\u0002'.repeat(4096)))
    assert.deepEqual(t.run('base64 -d partial'), expected('a', 1, 'base64: invalid input\n'))
    assert.deepEqual(t.run('base64 -d short'), expected('\u0001'))
    assert.deepEqual(t.run('base64 -d empty'), expected(''))
    assert.deepEqual(t.run('base64 -d long'), expected('\0\u0001\u0002'.repeat(4096)))
  })
})
