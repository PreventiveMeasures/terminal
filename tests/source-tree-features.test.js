import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

async function supported(command, files, stdout, exitCode = 0) {
  const r = await createTerminal(files).run(command)
  assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, '', exitCode, []], command)
}

describe('source analysis features — permanent regressions', () => {
  it('groups find predicates with negation, precedence, actions, and global depth', async () => {
    const files = { 'src/a.js': '', 'src/b.ts': '', 'src/c.txt': '', 'src/sub/d.js': '' }
    await supported("find src -type f \\( -name '*.js' -o -name '*.ts' \\) -print | sort", files, 'src/a.js\nsrc/b.ts\nsrc/sub/d.js\n')
    await supported("find src -type f ! \\( -name '*.js' -o -name '*.ts' \\)", files, 'src/c.txt\n')
    await supported("find src \\( -name '*.js' -print \\) -o -name '*.ts'", files, 'src/a.js\nsrc/sub/d.js\n')
    await supported("find src \\( -maxdepth 1 -type f \\) -exec echo {} + | sort", files, 'src/a.js src/b.ts src/c.txt\n')
    await supported("find src/a.js \\( -print -exec false \\; \\) -o -exec echo fallback \\;", files, 'src/a.js\nfallback\n')
    await supported("find src/a.js ! \\( -exec echo batch {} + \\) -print", files, 'batch src/a.js\n')
  })
  it('preserves embedded newlines and empty NUL records through sorting', async () => {
    await supported('sort -z f g', { f: 'b\na\0\0a', g: 'z\0a\0' }, '\0a\0a\0b\na\0z\0')
    await supported('sort -zu -t: -k2,2n f', { f: 'a:10\0b:01\0c:1\0' }, 'b:01\0a:10\0')
    await supported('find src -type f -print0 | sort -z | xargs -0 -r wc -c', { 'src/a\nb': 'ab', 'src/c d': 'x' }, "2 'src/a'$'\\n''b'\n1 src/c d\n3 total\n")
  })
  it('binary filtering retains filename/count operands and never selects inverted lines', async () => {
    const files = { binary: 'TODO\0x\n', text: 'TODO\n', empty: '' }
    await supported('grep -Ic TODO binary text empty', files, 'binary:0\ntext:1\nempty:0\n')
    await supported('grep -IL TODO binary text empty', files, 'binary\nempty\n')
    await supported('grep -Ivc TODO binary', files, '0\n', 1)
    await supported('grep -Iq TODO binary', files, '', 1)
  })
  it('does not inspect excluded binary files or binary contents under -m0', async () => {
    const files = { binary: 'TODO\n'.repeat(30000) + '\0' }
    await supported('grep -Iq --exclude=binary TODO binary', files, '', 1)
    await supported('grep -ILm0 TODO binary', files, 'binary\n', 1)
  })
  it('ASCII code patterns work in Unicode source files', async () => {
    await supported("grep -noE '[A-Za-z_][A-Za-z0-9_]*\\(' f", { f: 'café 😀 call(x)\n' }, '1:call(\n')
    await supported("grep -E '^import.*from' f", { f: 'import café from "x"\n' }, 'import café from "x"\n')
    await supported('grep -oE \'"[^"]+"[[:space:]]*:\' f', { f: '"café": "😀"\n' }, '"café":\n')
  })
  it('substitutions support captures, longest matches, empty matches and ordered scripts', async () => {
    await supported("sed -n 's/a/b/ p' f", { f: 'a\nx\n' }, 'b\n')
    await supported("sed -n 's/a/b/ g p' f", { f: 'aa\nx\n' }, 'bb\n')
    await supported("sed 's/\\(a\\|ab\\)/[&]/g' f", { f: 'ab ab\n' }, '[ab] [ab]\n')
    await supported("sed 's/\\(ab\\)c/\\1-&/' f", { f: 'abc\n' }, 'ab-abc\n')
    await supported("sed 's/b*/-/g' f", { f: 'abc' }, '-a-c-')
    await supported("sed -n '1s/a/b/p;1,2p' f g", { f: 'a', g: 'c\n' }, 'b\nb\nc\n')
    await supported("sed 's+[a+]\\++X+' f", { f: 'a+\n' }, 'X\n')
    await supported("sed 's/[[:blank:]]*$//' f", { f: 'café \t\nline \r\n' }, 'café\nline \r\n')
  })
  it('named classes and Unicode whitespace read the C.UTF-8 tables', async () => {
    await supported("grep -oE '[[:alpha:]]+' f", { f: 'é \n' }, 'é\n')
    await supported("grep -E '[[:space:]]' f", { f: '\u2003\n' }, '\u2003\n')
    await supported("sed 's/[[:alpha:]]/x/' f", { f: 'é' }, 'x')
  })
  it('diagnoses unmodeled regex and binary behavior even with stderr hidden', async () => {
    const cases = [
      ['grep -I TODO f', { f: 'TODO\n'.repeat(30000) + '\0' }, 'late binary detection'],
      ["grep -iE '(é)\\1' f", { f: 'é \n' }, 'non-ASCII regex semantics'],
      ["sed 's/a/b/e' f", { f: 'a' }, 'substitution flag e'],
      ["sed 's/\\(a\\)\\|\\(ab\\)/\\1/g' f", { f: 'ab' }, 'regex capture semantics'],
      ["sed 's/в/x/I' f", { f: '\u1C80' }, 'case folding of Cyrillic Extended-C letters'],
    ]
    for (const [command, files, detail] of cases) {
      const r = await createTerminal(files).run(command)
      assert.notEqual(r.exitCode, 0, command)
      assert.ok(r.stderr, command)
      assert.equal(r.unsupported[0]?.detail, detail, command)
      const hidden = await createTerminal(files).run(`${command} 2>/dev/null | cat`)
      assert.equal(hidden.stderr, '', command)
      assert.deepEqual(hidden.unsupported, r.unsupported, command)
    }
  })
})
