import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  'package.json': '{"name":"example"}\n',
  'src/a.txt': 'TODO\nTODO again\n',
  'src/b.txt': 'done\n',
  input: 'first\nsecond\n',
}

function check(command, stdout, exitCode = 0, stderr = '', cwd = '/', notes = []) {
  assert.deepEqual(createTerminal(FILES).run(command), { stdout, stderr, exitCode, cwd, notes, unsupported: [] }, command)
}

describe('shell if — branches and status', () => {
  const cases = [
    ['if true; then echo yes; fi', 'yes\n', 0],
    ['if false; then echo lost; fi', '', 0],
    ['if false; then echo lost; else echo no; fi', 'no\n', 0],
    ['if true; then echo yes; else echo lost; fi', 'yes\n', 0],
    ['if false; then echo lost; elif true; then echo second; else echo lost; fi', 'second\n', 0],
    ['if false; then echo lost; elif false; then echo lost; else echo fallback; fi', 'fallback\n', 0],
    ['if false; then echo lost; elif false; then echo lost; fi', '', 0],
    ['if true; then false; fi', '', 1],
    ['if false; then true; else false; fi', '', 1],
    ['if false; then true; elif true; then false; fi', '', 1],
    ['if echo checked; false; then echo lost; else echo fallback; fi', 'checked\nfallback\n', 0],
    ['if false; true; then echo yes; fi', 'yes\n', 0],
    ['if true && false; then echo lost; else echo no; fi', 'no\n', 0],
    ['if false || true; then echo yes; fi', 'yes\n', 0],
    ['if ! false; then echo yes; fi', 'yes\n', 0],
    ['if printf hit | grep -q hit; then echo found; fi', 'found\n', 0],
    ['if true; then false; fi || echo recovered', 'recovered\n', 0],
    ['if false; then echo lost; fi && echo continued', 'continued\n', 0],
    ['if true; then echo "$?"; else echo lost; fi', '0\n', 0],
    ['if false; then echo lost; else echo "$?"; fi', '1\n', 0],
    ['if false; then echo lost; elif echo "$?"; then echo chosen; fi', '1\nchosen\n', 0],
    ['if true; then printf before; exit 7; echo lost; fi; echo lost', 'before', 7],
  ]
  for (const [command, stdout, exitCode] of cases) it(command, () => check(command, stdout, exitCode))

  it('accepts newline-separated conditions and bodies', () => {
    check('if\nfalse\nthen\necho lost\nelif\ntrue\nthen\necho found\nelse\necho lost\nfi', 'found\n')
  })

  it('retains output and ordinary errors from evaluated conditions', () => {
    check('if cat missing; then echo lost; elif echo checked; false; then echo lost; else echo fallback; fi',
      'checked\nfallback\n', 0, 'cat: missing: no such file or directory\n')
  })

  it('does not execute later conditions after choosing a branch', () => {
    check('if true; then echo first; elif cat missing; then echo lost; else cat missing; fi', 'first\n')
  })
})

describe('shell if — source analysis and nested execution', () => {
  const cases = [
    ['if test -f package.json; then cat package.json; else ls; fi', '{"name":"example"}\n'],
    ['if [ -f missing ]; then cat missing; elif [ -f package.json ]; then echo package; fi', 'package\n'],
    ['if [ "$(grep -c TODO src/a.txt)" != "0" ]; then echo matches; fi', 'matches\n'],
    ['if count=$(grep -c TODO src/b.txt); then echo lost; else echo "$count"; fi', '0\n'],
    ['for f in src/*.txt; do if grep -q TODO "$f"; then echo "$f"; fi; done', 'src/a.txt\n'],
    ['for f in $(find src -name "*.txt"); do if grep -q TODO "$f"; then echo "$f"; fi; done', 'src/a.txt\n'],
    ['if true; then if false; then echo lost; else echo nested; fi; else echo lost; fi', 'nested\n'],
    ['if if false; then false; else true; fi; then echo nested-condition; fi', 'nested-condition\n'],
    ['if true; then for x in a b; do echo "$x"; done; fi', 'a\nb\n'],
    ['for x in a b c; do if [ "$x" = b ]; then continue; fi; echo "$x"; done', 'a\nc\n'],
    ['for x in a b c; do if [ "$x" = b ]; then break; fi; echo "$x"; done', 'a\n'],
    ['echo "$(if true; then echo inner; else echo lost; fi)"', 'inner\n'],
    ['if [ "$(echo yes)" = yes ]; then echo "$(echo chosen)"; fi', 'chosen\n'],
    ['x=before; if x=condition; then x=after; fi; echo "$x"', 'after\n'],
    ['if true; then echo then else elif fi; fi', 'then else elif fi\n'],
    ["if test x = x; then echo 'fi'; fi", 'fi\n'],
  ]
  for (const [command, stdout] of cases) it(command, () => check(command, stdout))

  it('runs conditions and bodies in the current shell', () => {
    check('if cd src; then pwd; fi; pwd', '/src\n/src\n', 0, '', '/src')
  })

  it('isolates state when the conditional is in a pipeline or subshell', () => {
    check('x=outer; if true; then x=inner; cd src; pwd; fi | cat; echo "$x"; pwd', '/src\nouter\n/\n')
    check('x=outer; (if true; then x=inner; cd src; pwd; fi); echo "$x"; pwd', '/src\nouter\n/\n')
  })

  it('shares redirected input between an evaluated condition and its body', () => {
    check('if head -n1; then cat; fi < input', 'first\nsecond\n', 0, '', '/', ['head: selected 1 of 2 lines from standard input.'])
  })

  it('applies redirection to the whole conditional', () => {
    check('if echo condition; then echo body; fi >/dev/null', '')
    check('if cat missing; then echo lost; else echo fallback; fi 2>/dev/null', 'fallback\n', 0, '', '/',
      ["stderr: a redirect discarded \"cat: missing: no such file or directory\". Nothing else in this run reports that path."])
  })
})

describe('shell if — diagnostics and malformed syntax', () => {
  it('does not report unsupported commands in skipped conditions or bodies', () => {
    check('if true; then echo okay; elif grep --unknown x input; then echo lost; else grep --unknown x input; fi', 'okay\n')
    check('if false; then echo "$(grep --unknown x input)"; else echo okay; fi', 'okay\n')
    check('false && if grep --unknown x input; then echo lost; fi', '', 1)
  })

  it('retains unsupported condition diagnostics when an else branch succeeds', () => {
    const r = createTerminal(FILES).run('if grep --unknown x input; then echo lost; else echo fallback; fi 2>/dev/null')
    assert.deepEqual(r, {
      stdout: 'fallback\n', stderr: '', exitCode: 0, cwd: '/',
      notes: [], unsupported: [{ kind: 'option', command: 'grep', detail: '--unknown', message: 'grep: unknown option: --unknown' }],
    })
  })

  it('diagnoses invalid conditional grammar as syntax errors', () => {
    for (const command of [
      'if', 'if true', 'if true; then echo x', 'if true; fi',
      'if ; then echo x; fi', 'if true; then; fi',
      'if true; then echo x; else; fi',
      'if true; then echo x; elif; then echo y; fi',
      'if true; then echo x; else echo y; elif true; then echo z; fi',
      'then', 'elif true; then echo x; fi', 'else echo x; fi', 'fi',
    ]) {
      const r = createTerminal(FILES).run(command)
      assert.equal(r.stdout, '', command)
      assert.equal(r.exitCode, 2, command)
      assert.notEqual(r.stderr, '', command)
      assert.deepEqual(r.unsupported, [], command)
    }
  })
})
