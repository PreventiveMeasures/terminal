import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { FILESYSTEM_WORKFLOWS } from './fixtures/unsupported-filesystem-workflows.js'
import { TEXT_FILES, TEXT_WORKFLOWS } from './fixtures/unsupported-text-workflows.js'
import { SHELL_FILES, SHELL_WORKFLOWS } from './fixtures/unsupported-shell-workflows.js'

const FILES = {
  'package.json': '{"name":"audit-fixture","version":"1.0.0","scripts":{"test":"node --test"}}\n',
  'README.md': '# Fixture\nA small project for command analysis.\n',
  'src/index.js': 'import { helper } from "./util.js";\n// TODO: validate input\nexport const value = helper(1);\n',
  'src/util.js': '// FIXME: handle empty input\nexport function helper(value) { return value; }\n',
  'test/index.test.js': 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n',
  'data/metrics.tsv': 'name\tscore\nalpha\t10\nbeta\t2\n',
  'data/names.txt': 'beta\nalpha\nalpha\n',
  'data/utf8.txt': 'café naïve\nΣ value\n',
  'data/paths.txt': 'src/index.js\nsrc/util.js\n',
  'data/declared-names.txt': 'alpha\nbeta\ngamma\n',
  'data/used-names.txt': 'alpha\ngamma\n',
  'data/roots.list': 'src\0test\0',
  'config/default.json': '{"enabled":true}\n',
  'patterns.txt': 'TODO\nFIXME\n',
  ...TEXT_FILES,
  ...SHELL_FILES,
}
const CASES = [...FILESYSTEM_WORKFLOWS, ...TEXT_WORKFLOWS, ...SHELL_WORKFLOWS]
const identities = (result) => result.unsupported.map(({ kind, command, detail }) => ({ kind, command, detail }))

function checkDiagnostics(result, expected, line) {
  assert.deepEqual(identities(result), expected, line)
  assert.ok(Object.isFrozen(result.unsupported), line)
  for (const entry of result.unsupported) {
    assert.ok(Object.isFrozen(entry), line)
    assert.equal(typeof entry.message, 'string', line)
    assert.notEqual(entry.message.trim(), '', line)
  }
}

it('covers exactly 100 distinct realistic agent commands', () => {
  assert.equal(CASES.length, 100)
  assert.equal(new Set(CASES.map((c) => c.command)).size, 100)
  assert.equal(new Set(CASES.map((c) => c.purpose)).size, 100)
  for (const c of CASES) {
    assert.ok(c.expected.length > 0, c.command)
    assert.ok(c.purpose.length > 0, c.command)
    assert.ok(!c.command.includes('--audit-missing-option'), c.command)
  }
})

describe('100 likely agent commands — unsupported channel', () => {
  for (const [i, c] of CASES.entries()) {
    describe((i + 1) + '. ' + c.purpose, () => {
      it(c.command, () => {
        const result = createTerminal(FILES).run(c.command)
        checkDiagnostics(result, c.expected, c.command)
        assert.notEqual(result.exitCode, 0, c.command)
        assert.notEqual(result.stderr, '', c.command)
        for (const note of result.unsupported) assert.ok(result.stderr.includes(note.message), c.command)
      })
      for (const [context, wrap] of [
        ['hidden stderr and a successful final pipeline stage', (line) => '{ ' + line + '\n} 2>/dev/null | cat'],
        ['subshell with discarded output and error recovery', (line) => '( ' + line + '\n) >/dev/null 2>&1 || true'],
        ['repeated execution with deduplicated diagnostics', (line) => 'for audit_item in one two; do { ' + line + '\n}; done 2>/dev/null | true'],
      ]) {
        it(context, () => {
          const line = wrap(c.command)
          const result = createTerminal(FILES).run(line)
          checkDiagnostics(result, c.expected, line)
          if (c.parseTime) {
            // Parsing happens before shell redirects can be installed.
            assert.notEqual(result.stderr, '', line)
            assert.notEqual(result.exitCode, 0, line)
          } else {
            assert.equal(result.stderr, '', line)
            assert.equal(result.exitCode, 0, line)
          }
        })
      }
    })
  }
})

describe('likely agent commands — diagnostic boundaries', () => {
  for (const [command, stdout] of [
    ['name=src/index.js; echo "${name//\\//_}"', 'src_index.js\n'],
    ['file=src/index.js; echo "${file:0:3}"', 'src\n'],
  ]) {
    it(command, () => {
      assert.deepEqual(createTerminal(FILES).run(command), { stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [] })
    })
  }

  it('accepts the reported find -exec spelling with an escaped semicolon', () => {
    const t = createTerminal({ 'a.txt': 'one\ntwo\n', 'sub/a.txt': 'three\n', 'other.txt': 'ignored\n' })
    const command = String.raw`find . -name "a.txt" -exec wc -l {} \;`
    assert.deepEqual(t.run(command), {
      stdout: '2 ./a.txt\n1 ./sub/a.txt\n', stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
    })
    assert.deepEqual(t.run(command), t.run(String.raw`find . -name "a.txt" -exec wc -l {} ';'`))
  })

  it('accepts the reported BRE alternation with literal quoted parentheses', () => {
    const t = createTerminal({
      'dir/a.txt': 'b.a\nc.a\nX("b")\nXb\nother\n',
      'dir/skip.js': 'b.a\n', 'dir/sub/b.txt': 'bza\ncza\n',
    })
    const command = String.raw`grep -rn "b.a\|c.a\|X(\"b\")" dir/ --include=*.txt`
    assert.deepEqual(t.run(command), {
      stdout: 'dir/a.txt:1:b.a\ndir/a.txt:2:c.a\ndir/a.txt:3:X("b")\ndir/sub/b.txt:1:bza\ndir/sub/b.txt:2:cza\n',
      stderr: '', exitCode: 0, cwd: '/', unsupported: [], notes: [
        'glob: no paths matched "--include=*.txt"; the pattern was left literal.',
        'grep: excluded 1 entry by --include/--exclude/--exclude-dir rules: "/dir/skip.js".',
      ],
    })
  })

  it('keeps valid source analysis free of false unsupported entries', () => {
    for (const line of [
      'find src -type f -name "*.js" -print',
      String.raw`find src -type f -exec wc -l {} \;`,
      'find src -type f -print0 | xargs -0 wc -l',
      "grep -rn TODO src --include='*.js'",
      "sed -n '1,2p' src/index.js",
      'sort data/names.txt | uniq -c',
      "awk -F '\\t' 'NR > 1 {sum += $2} END {print sum}' data/metrics.tsv",
    ]) {
      const result = createTerminal(FILES).run(line)
      assert.deepEqual(result.unsupported, [], line)
      assert.equal(result.stderr, '', line)
      assert.equal(result.exitCode, 0, line)
    }
  })

  it('keeps ordinary errors off the implementation-gap channel', () => {
    for (const line of [
      'cat missing.js', 'cd src/index.js', 'grep NEVER_PRESENT src/index.js',
      'find src -name', "find src -exec wc -l '{}'",
      'cut -f0 data/metrics.tsv', 'head -nINVALID README.md',
      "awk 'BEGIN {print (}'", 'cat src/index.js |',
    ]) {
      const result = createTerminal(FILES).run(line)
      assert.deepEqual(result.unsupported, [], line)
      assert.notEqual(result.exitCode, 0, line)
    }
  })

  it('reports only commands actually executed', () => {
    for (const c of CASES.filter((entry) => !entry.parseTime)) {
      const line = 'false && { ' + c.command + '\n}'
      const result = createTerminal(FILES).run(line)
      assert.deepEqual(result.unsupported, [], line)
      assert.equal(result.stderr, '', line)
      assert.equal(result.exitCode, 1, line)
    }
  })

  it('retains separate diagnostics in encounter order through nested dispatch', () => {
    const t = createTerminal(FILES)
    const line = String.raw`{ find src -type f -exec grep -P '(?>TODO)' {} \; ; cat data/paths.txt | xargs sed -i 's/TODO/DONE/g'; jq '.scripts' package.json; } 2>/dev/null | true`
    const r = t.run(line)
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 0)
    assert.deepEqual(identities(r), [
      { kind: 'feature', command: 'grep', detail: 'PCRE group' },
      { kind: 'feature', command: 'sed', detail: '-i' },
      { kind: 'command', command: 'jq', detail: 'jq' },
    ])
    assert.deepEqual(t.run('cat package.json').unsupported, [], 'feeds reset between runs')
  })
})
