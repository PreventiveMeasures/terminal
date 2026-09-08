import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

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
