import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const CASES = [
  ["sed -n '/^export /,/^}/p' input", 'import x\nexport function f() {\n  body\n}\nother\n', 'export function f() {\n  body\n}\n'],
  ["sed -E 's/^(export|import) /module /' input", 'import x\nexport y\nother\n', 'module x\nmodule y\nother\n'],
  ...['-E', '-r', '--regexp-extended'].map(flag => [
    `sed ${flag} -n '/^(a|b)[0-9]+$/p' input`, 'a1\nb22\na+\na1x\nc1\n', 'a1\nb22\n',
  ]),
  [String.raw`sed -E 's|a\|b|X|' input`, 'a|b\nab\na\nb\n', 'X|b\nXb\nX\nX\n'],
  ...['', '-E'].map(flag => [String.raw`sed ${flag} 's.a\.b.X.' input`, 'a.b\na-b\nab\n', 'X\nX\nab\n']),
  ["sed -n '0,/end/p' input", 'end\nbody\nend\nafter\n', 'end\n'],
  ["sed -n '1,/end/p' input", 'end\nbody\nend\nafter\n', 'end\nbody\nend\n'],
  ["sed -n '/a/,2p' input", 'before\na\noutside\na\na\noutside\n', 'a\na\na\n'],
  ["sed -n '2,+1p' input", 'one\ntwo\nthree\nfour\n', 'two\nthree\n'],
  ["sed -n '1,0p' input", 'one\ntwo\nthree\n', 'one\n'],
  ["sed -n '1,+ 2p' input", 'one\ntwo\nthree\nfour\n', 'one\ntwo\nthree\n'],
  ["sed -n ' 1 , 2 p ; $ p ' input", 'one\ntwo\nthree\n', 'one\ntwo\nthree\n'],
  ["sed '/start/,/end/s/a/A/g' input", 'a\nstart a\na body\nend a\na\n', 'a\nstArt A\nA body\nend A\na\n'],
  ["sed -n '/start/,/end/s/a/A/gp' input", 'a\nstart a\nbody\nend a\na\n', 'stArt A\nend A\n'],
  ["sed -n '/start/,/end/p;/start/,/end/p' input", 'start\nend\nafter\n', 'start\nstart\nend\nend\n'],
  ["sed -n 's/2/X/;/[0-9]/p' input", '1\n2\n3\n', '1\n3\n'],
  ["sed -n 's/X/end/;/start/,/end/p' input", 'start\nX\noutside\n', 'start\nend\n'],
  [String.raw`sed -n '/^a\/b$/p' input`, 'a/b\nab\n', 'a/b\n'],
  [String.raw`sed -n '/^a\tb$/p' input`, 'a\tb\natb\n', 'a\tb\n'],
  [String.raw`sed -n '1,\%end%p' input`, 'a\nend\nafter\n', 'a\nend\n'],
  [String.raw`sed -n '\%a%p' input`, 'a\nb\n', 'a\n'],
  ["sed -n '/a/!p' input", 'a\nb\n', 'b\n'],
  ["sed -n '/a/{p;}' input", 'a\nb\n', 'a\n'],
  ["sed -n '/[/]/p;/[;]$/p' input", '/\n;\nx\n', '/\n;\n'],
  ["sed -n '/^a$/p' input", 'a\r\na\n', 'a\n'],
  [String.raw`sed -n 's/x/\n/;/^$/p' input`, 'x\n\n', '\n'],
  ["sed -n '/start/,/end$/p' input", 'start\nend\r\nbody\nend\nafter\n', 'start\nend\r\nbody\nend\n'],
]

describe('sed address and regex boundaries', () => {
  for (const [command, input, stdout] of CASES) {
    it(command, () => {
      const terminal = createTerminal({ input })
      const expected = { stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [] }
      assert.deepEqual(terminal.run(command), expected)
      assert.deepEqual(terminal.run(command), expected, 'range state resets between invocations')
    })
  }

  it('retains read errors while a regex range spans surviving input files', () => {
    const result = createTerminal({ first: 'start\n', last: 'body\nend' }).run("sed -n '/start/,/end/p' first missing last")
    assert.equal(result.stdout, 'start\nbody\nend')
    assert.match(result.stderr, /missing: no such file/u)
    assert.equal(result.exitCode, 2)
    assert.deepEqual(result.unsupported, [])
  })
})

describe('sed unsupported features retain diagnostics', () => {
  const gaps = [
    ["sed -n '/a/Mp' input", 'address regex flags'],
    ["sed -n '/a/ M p' input", 'address regex flags'],
    ["sed -n '1~2p' input", 'step address'],
    ["sed -n '0~2p' input", 'step address'],
    ["sed -n '/a/,~3p' input", 'step address'],
    [String.raw`sed -n '/\(a\)\1/p' input`, 'regex backreferences'],
    [String.raw`sed -E 's/(a)\1/x/' input`, 'regex backreferences'],
    [String.raw`sed -n '/\o101/p' input`, 'regex escape'],
    [String.raw`sed -E 's/\o101/x/' input`, 'regex escape'],
    ["sed -n 'p # comment' input", 'comments'],
    ["sed -n 'p# comment' input", 'comments'],
    ["sed -n 'p;# comment' input", 'comments'],
    ["sed 's/a/x/ # comment' input", 'comments'],
    [String.raw`sed -E 's/a/\U&/' input`, 'replacement escape'],
    [String.raw`sed -n '/[[:alpha:]]/p' unicode`, 'non-ASCII regex semantics'],
    ["sed -n '/^.$/p' unicode", 'non-ASCII regex semantics'],
  ]
  for (const [command, detail] of gaps) {
    it(command, () => {
      const terminal = createTerminal({ input: 'aa\n', unicode: 'é\n' })
      const result = terminal.run(command)
      assert.notEqual(result.exitCode, 0)
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported.map(({ kind, command: name, detail: gap }) => [kind, name, gap]), [['feature', 'sed', detail]])
      const hidden = terminal.run(`${command} 2>/dev/null | cat`)
      assert.equal(hidden.stderr, '')
      assert.equal(hidden.exitCode, 0)
      assert.deepEqual(hidden.unsupported, result.unsupported)
    })
  }

  it('preserves earlier output and its diagnostic when a later address cannot match reliably', () => {
    const terminal = createTerminal({ input: 'a\né\n' })
    for (const command of ["sed -n '/^.$/p' input", "sed -E 's/./x/' input"]) {
      const result = terminal.run(`${command} 2>/dev/null | cat`)
      assert.equal(result.stdout, command.includes('-n') ? 'a\n' : 'x\n')
      assert.equal(result.stderr, '')
      assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['non-ASCII regex semantics'])
    }
  })

  it('reports malformed addresses and replacement references as ordinary errors', () => {
    const terminal = createTerminal({ input: 'a\n' })
    for (const command of ["sed -n '0p' input", "sed -n '0,2p' input", "sed -n '//p' input",
      "sed -n '/unterminated' input", "sed -n '1,p' input", String.raw`sed -E 's/(a)/\2/' input`,
      ...[String.raw`a\)`, String.raw`a\(`, String.raw`a\{`].flatMap(pattern => [
        `sed -n '/${pattern}/p' input`, `sed 's/${pattern}/x/' input`,
      ])]) {
      const result = terminal.run(command)
      assert.notEqual(result.exitCode, 0, command)
      assert.notEqual(result.stderr, '', command)
      assert.deepEqual(result.unsupported, [], command)
    }
  })

  // GNU compile_regex rejects modifiers on empty patterns during compilation,
  // even when no input record could evaluate the address.
  // https://github.com/mirror/sed/blob/0c1fe22ccacf4887e0be6c11deb4e9c83acc287d/sed/regexp.c
  for (const script of ['//Ip', '//Mp', '//IMp', '// I p', '// M p', '/a/p;//Ip', String.raw`\%%Ip`]) {
    for (const input of ['', 'a\n']) {
      it(`empty address modifiers fail before reading ${input ? 'nonempty' : 'empty'} input: ${script}`, () => {
        assert.deepEqual(createTerminal({ input }).run(`sed -n '${script}' input`), {
          stdout: '', stderr: 'sed: cannot specify modifiers on empty regexp\n',
          exitCode: 1, cwd: '/', notes: [], unsupported: [],
        })
      })
    }
  }
})
