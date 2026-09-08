import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { materialize, missing, native } from './helpers/source-tree-reference.js'

const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'"
function supported(command, files, stdout, exitCode = 0) {
  const r = createTerminal(files).run(command)
  assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, '', exitCode, []], command)
}

describe('source analysis features — permanent regressions', () => {
  it('groups find predicates with negation, precedence, actions, and global depth', () => {
    const files = { 'src/a.js': '', 'src/b.ts': '', 'src/c.txt': '', 'src/sub/d.js': '' }
    supported("find src -type f \\( -name '*.js' -o -name '*.ts' \\) -print | sort", files, 'src/a.js\nsrc/b.ts\nsrc/sub/d.js\n')
    supported("find src -type f ! \\( -name '*.js' -o -name '*.ts' \\)", files, 'src/c.txt\n')
    supported("find src \\( -name '*.js' -print \\) -o -name '*.ts'", files, 'src/a.js\nsrc/sub/d.js\n')
    supported("find src \\( -maxdepth 1 -type f \\) -exec echo {} + | sort", files, 'src/a.js src/b.ts src/c.txt\n')
    supported("find src/a.js \\( -print -exec false \\; \\) -o -exec echo fallback \\;", files, 'src/a.js\nfallback\n')
    supported("find src/a.js ! \\( -exec echo batch {} + \\) -print", files, 'batch src/a.js\n')
  })
  it('preserves embedded newlines and empty NUL records through sorting', () => {
    supported('sort -z f g', { f: 'b\na\0\0a', g: 'z\0a\0' }, '\0a\0a\0b\na\0z\0')
    supported('sort -zu -t: -k2,2n f', { f: 'a:10\0b:01\0c:1\0' }, 'b:01\0a:10\0')
    supported('find src -type f -print0 | sort -z | xargs -0 -r wc -c', { 'src/a\nb': 'ab', 'src/c d': 'x' }, "2 'src/a'$'\\n''b'\n1 src/c d\n3 total\n")
  })
  it('binary filtering retains filename/count operands and never selects inverted lines', () => {
    const files = { binary: 'TODO\0x\n', text: 'TODO\n', empty: '' }
    supported('grep -Ic TODO binary text empty', files, 'binary:0\ntext:1\nempty:0\n')
    supported('grep -IL TODO binary text empty', files, 'binary\nempty\n')
    supported('grep -Ivc TODO binary', files, '0\n', 1)
    supported('grep -Iq TODO binary', files, '', 1)
  })
  it('does not inspect excluded binary files or binary contents under -m0', () => {
    const files = { binary: 'TODO\n'.repeat(30000) + '\0' }
    supported('grep -Iq --exclude=binary TODO binary', files, '', 1)
    supported('grep -ILm0 TODO binary', files, 'binary\n', 1)
  })
  it('ASCII code patterns work in Unicode source files', () => {
    supported("grep -noE '[A-Za-z_][A-Za-z0-9_]*\\(' f", { f: 'café 😀 call(x)\n' }, '1:call(\n')
    supported("grep -E '^import.*from' f", { f: 'import café from "x"\n' }, 'import café from "x"\n')
    supported('grep -oE \'"[^"]+"[[:space:]]*:\' f', { f: '"café": "😀"\n' }, '"café":\n')
  })
  it('substitutions support captures, longest matches, empty matches and ordered scripts', () => {
    supported("sed -n 's/a/b/ p' f", { f: 'a\nx\n' }, 'b\n')
    supported("sed -n 's/a/b/ g p' f", { f: 'aa\nx\n' }, 'bb\n')
    supported("sed 's/\\(a\\|ab\\)/[&]/g' f", { f: 'ab ab\n' }, '[ab] [ab]\n')
    supported("sed 's/\\(ab\\)c/\\1-&/' f", { f: 'abc\n' }, 'ab-abc\n')
    supported("sed 's/b*/-/g' f", { f: 'abc' }, '-a-c-')
    supported("sed -n '1s/a/b/p;1,2p' f g", { f: 'a', g: 'c\n' }, 'b\nb\nc\n')
    supported("sed 's+[a+]\\++X+' f", { f: 'a+\n' }, 'X\n')
    supported("sed 's/[[:blank:]]*$//' f", { f: 'café \t\nline \r\n' }, 'café\nline \r\n')
  })
  it('diagnoses unmodeled regex and binary behavior even with stderr hidden', () => {
    const cases = [
      ['grep -I TODO f', { f: 'TODO\n'.repeat(30000) + '\0' }, 'late binary detection'],
      ["grep -oE '.+.+ ' f", { f: 'é \n' }, 'non-ASCII regex semantics'],
      ["grep -E '[[:space:]]' f", { f: '\u2003\n' }, 'non-ASCII regex semantics'],
      ["sed 's/a/b/e' f", { f: 'a' }, 'substitution flags'],
      ["sed 's/\\(a\\)\\|\\(ab\\)/\\1/g' f", { f: 'ab' }, 'regex capture semantics'],
      ["sed 's/./x/' f", { f: 'é' }, 'non-ASCII regex semantics'],
    ]
    for (const [command, files, detail] of cases) {
      const r = createTerminal(files).run(command)
      assert.notEqual(r.exitCode, 0, command)
      assert.ok(r.stderr, command)
      assert.equal(r.unsupported[0]?.detail, detail, command)
      const hidden = createTerminal(files).run(`${command} 2>/dev/null | cat`)
      assert.equal(hidden.stderr, '', command)
      assert.deepEqual(hidden.unsupported, r.unsupported, command)
    }
  })
})

const inputs = ['', 'a', 'a\n', '\n\n', 'ab abc\naab\n', ' a\tb \n\r\n', 'a/a#a+a\na&b\\n\n', 'a\0b\n']
const scripts = ['', 'p', '1p', '2,1p', 's/a/X/', 's/a//', 's/a/X/g', 's/a/X/p', 's/a/X/ p', 's/a/X/ g p', 's/a/X/gp', 's/b*/-/g', 's/^/</;s/$/>/', 's/[[:blank:]]*$//', 's/./[&]/g', 's/a*/(&)/g', 's/a\\|ab/Z/g', 's/\\(ab\\)c/\\1-&/', 's#/#:#g', 's+\\++X+g', 's/[a/]/X/g', 's/[[:alpha:]]/X/g', 's/a/\\&/g', 's/a/\\\\/g', 's/\\t/X/g', 's/a/\\n/g', '1s/a/b/p;1,2p', 's/[]a]/X/g', 's/[^]a]/X/g']
const findExpressions = [
  "\\( -name '*.js' -o -name '*.ts' \\)", "! \\( -name '*.js' -o -name '*.ts' \\)",
  "\\( -name '*.js' -print \\) -o -name '*.ts'", "\\( -type f -a \\( -name '*.js' -o -name '*.ts' \\) \\) -print",
  "\\( -name node_modules -prune \\) -o -type f -print", "\\( -maxdepth 1 -type f \\) -print",
  "! \\( -print -exec false \\; \\)", "\\( -name '*.js' -exec wc -l {} + \\) -o -name '*.ts' -print",
  "\\( -name '*.js' -o -name '*.ts' \\) -exec echo {} \\;", "\\( -mindepth 1 -name '*.js' \\) -print",
  "! ! \\( -type f \\)", "\\( -name '(' -o -name ')' \\)", "\\( -exec echo '(' {} ')' \\; \\)",
]

describe('source analysis features — strict GNU matrices', { skip: missing.length ? `Missing native tools: ${missing.join(', ')}` : false }, () => {
  const dir = materialize({})
  after(() => rmSync(dir, { recursive: true, force: true }))
  function compare(command, files) {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    const ref = native(command, dir)
    supported(command, files, ref.stdout, ref.exitCode)
    assert.equal(ref.stderr, '', command)
  }
  for (const script of scripts) {
    for (const input of inputs) {
      for (const flag of ['', '-n']) {
        const command = `sed ${flag} ${quote(script)} f g`
        it(`${command}: ${JSON.stringify(input)}`, () => compare(command, { f: input, g: 'ab\n' }))
      }
    }
  }
  for (const flags of ['-z', '-zu', '-zn', '-znu', '-zfr', '-z -t: -k2,2nr']) {
    for (const input of ['', '\0', '\0\0', 'b\na\0a\0', 'b\0a', ['2', '10', '01', '1', ''].join('\0'), 'a:10\0b:1\0c:01\0', 'é\0z\0']) {
      const command = `sort ${flags} f g`
      it(`${command}: ${JSON.stringify(input)}`, () => compare(command, { f: input, g: 'a\0' }))
    }
  }
  for (const flag of ['', '-c', '-v', '-vc', '-l', '-L', '-q', '-o', '-m0', '-m1', '-nC1']) {
    for (const input of ['a\0x\n', 'x\na\0\n', '\0', '\n', 'a\n']) {
      const command = `grep -I ${flag} a f g`
      it(`${command}: ${JSON.stringify(input)}`, () => compare(command, { f: input, g: 'x\n' }))
    }
  }
  for (const name of ['a\nb', '\n', 'a\n', "a'\nb", 'a\t\nb', 'a\r\nb', 'a\u0001\nb', 'a\\\nb', 'a\nb"c', "a\n'b\"c", 'é\n😀', 'a\tb', 'a\rb']) {
    for (const locale of ['', 'LC_ALL=C ']) {
      const command = `${locale}wc -c -- ${quote(name)}`
      it(`wc filename quoting: ${JSON.stringify([locale, name])}`, () => compare(command, { [name]: 'x' }))
    }
  }
  const files = { 'src/a.js': '', 'src/b.ts': '', 'src/c.txt': '', 'src/lib/z.js': '', 'src/node_modules/x.js': '' }
  const treeDir = materialize(files)
  after(() => rmSync(treeDir, { recursive: true, force: true }))
  for (const expression of findExpressions) {
    const command = `find src ${expression} | sort`
    it(command, () => {
      const ref = native(command, treeDir)
      supported(command, files, ref.stdout, ref.exitCode)
      assert.equal(ref.stderr, '')
    })
  }
  for (const expression of ['\\(', '\\)', '\\( \\)', '\\( -name a', '-name a \\)', '\\( -name a -o \\)', '! \\)', '\\( -a -type f \\)']) {
    const command = `find src ${expression}`
    it(`invalid find group: ${expression}`, () => {
      const ref = native(command, treeDir)
      const r = createTerminal(files).run(command)
      assert.deepEqual(r.unsupported, [])
      // A ')' before the expression is a root operand, so this case also
      // walks src. Find sibling traversal order is unspecified.
      assert.deepEqual([r.stdout.split('\n').sort(), r.exitCode, Boolean(r.stderr)], [ref.stdout.split('\n').sort(), ref.exitCode, Boolean(ref.stderr)])
    })
  }
})
