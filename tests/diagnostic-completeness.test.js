import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { DEFAULT_REGISTRY } from '../src/registry.js'
import { SHELL_GAPS } from '../src/shell/builtins.js'
import { createUnsupportedFeed } from '../src/unsupported.js'

const FILES = { f: 'a 1\nb 2\na 1\n', u: 'é😀\n', 'src/a.js': 'const a = 1\n' }
const run = (command) => createTerminal(FILES).run(command)
const identity = (result) => result.unsupported.map(({ kind, command, detail }) => ({ kind, command, detail }))

// These builtins interpret option-like tokens as data, counts, or expressions.
// Every other registered command must diagnose unavailable options.
const NO_OPTIONS = new Set(['echo', 'true', 'false', ':', 'exit', 'break', 'continue', 'test', '['])
const registered = { ...DEFAULT_REGISTRY.commands, ...DEFAULT_REGISTRY.hidden }

describe('diagnostic completeness — command dispatch', () => {
  for (const name of Object.keys(registered).filter((key) => !NO_OPTIONS.has(key))) {
    it(name + ': unavailable options survive redirects and nested dispatch', () => {
      const command = name + ' --audit-missing-option'
      const direct = run(command)
      assert.notEqual(direct.exitCode, 0)
      assert.notEqual(direct.stderr, '')
      assert.equal(direct.unsupported.length, 1)
      assert.equal(direct.unsupported[0].command, name)
      for (const wrapped of [
        command + ' 2>/dev/null | cat',
        '{ ' + command + '; } >/dev/null 2>&1 || true',
        '(' + command + ') 2>/dev/null | true',
        'for item in one two; do ' + command + '; done 2>/dev/null',
        "find src -type f -exec " + command + " {} ';' 2>/dev/null | true",
        'echo item | xargs ' + command + ' 2>/dev/null | true',
      ]) {
        const result = run(wrapped)
        const external = DEFAULT_REGISTRY.shellOnly(name) && (wrapped.startsWith('find ') || wrapped.startsWith('echo '))
        assert.deepEqual(identity(result), external ? [{ kind: 'command', command: name, detail: name }] : identity(direct), wrapped)
        assert.equal(result.stderr, '', wrapped)
      }
    })
  }
  for (const name of SHELL_GAPS.keys()) {
    it(name + ': unavailable shell builtin cannot disappear in a pipeline', () => {
      const r = run(name + ' 2>/dev/null | true')
      assert.equal(r.exitCode, 0)
      assert.equal(r.stderr, '')
      assert.deepEqual(r.unsupported.map((u) => u.detail), [name])
    })
  }
  it('ignores arguments only where the real builtin does', () => {
    for (const name of ['echo', 'true', 'false', ':']) {
      const r = run(name + ' --audit-missing-option')
      assert.deepEqual(r.unsupported, [])
      assert.equal(r.stdout, name === 'echo' ? '--audit-missing-option\n' : '')
    }
    for (const name of ['exit', 'break', 'continue']) {
      const r = run(name + ' --audit-missing-option')
      assert.deepEqual(r.unsupported, [])
      assert.notEqual(r.exitCode, 0)
    }
    for (const command of ['test --audit-missing-option', '[ --audit-missing-option ]']) {
      const r = run(command)
      assert.equal(r.exitCode, 0)
      assert.equal(r.stdout, '')
      assert.equal(r.stderr, '')
      assert.deepEqual(r.unsupported, [])
    }
  })
})

const COMMAND_GAPS = [
  ['find . ! -mtime 1', '-mtime'],
  ['find . -not -newer f', '-newer'],
  ['find . -type f , -print', 'comma operator'],
  ['find . -type f,l', '-type f,l'],
  ['grep --e a f', '--e'],
  [String.raw`grep -E 'a{,2}' f`, 'GNU regex syntax'],
  [String.raw`grep -wE 'a{,2}' f`, 'GNU regex syntax'],
  [String.raw`grep -E 'a{z}' f`, 'GNU regex syntax'],
  [String.raw`grep -E '{1}' f`, 'GNU regex syntax'],
  [String.raw`grep 'a\{,2\}' f`, 'GNU regex syntax'],
  [String.raw`awk 'BEGIN {print "\😀"}'`, 'non-ASCII string escape'],
  ['seq inf', 'non-integer operands'],
  ['seq -- -inf 2', 'non-integer operands'],
  [String.raw`awk 'BEGIN {x="out";print "lost" > x}'`, 'output redirection'],
  [String.raw`awk 'BEGIN {x="out";printf "%s", "lost" >> x}'`, 'output redirection'],
  [String.raw`awk 'BEGIN {a[1][2]=3}'`, 'arrays of arrays'],
  [String.raw`awk 'BEGIN {delete a[1][2]}'`, 'arrays of arrays'],
  [String.raw`awk 'BEGIN {print sub(/a/,"b","a")}'`, 'substitution into temporary value'],
  [String.raw`awk 'BEGIN {print gsub(/a/,"b",42)}'`, 'substitution into temporary value'],
  [String.raw`awk 'BEGIN {x=@/a/}'`, '@ extensions'],
  [String.raw`awk '@include "f"'`, '@ extensions'],
  [String.raw`awk 'BEGIN {print audit::value}'`, 'namespaces'],
  [String.raw`awk 'BEGIN {printf "%a", 1.5}'`, 'hexadecimal float format'],
  [String.raw`awk 'BEGIN {printf "%A", 1.5}'`, 'hexadecimal float format'],
  [String.raw`awk 'BEGIN {printf "%2$s", "a", "b"}'`, 'positional format arguments'],
  [String.raw`awk 'BEGIN {printf "%*2$s", 4, "a"}'`, 'positional format arguments'],
  [String.raw`awk 'BEGIN {printf "%1000001s", "a"}'`, 'format size limit'],
  [String.raw`awk 'BEGIN {printf "%.*f", 101, 1.5}'`, 'float precision limit'],
  [String.raw`awk 'BEGIN {OFMT="%1000001f"; print 1.5}'`, 'format size limit'],
  [String.raw`awk 'BEGIN {CONVFMT="%.1000001d"; print 1.5 ""}'`, 'format size limit'],
  [String.raw`awk 'BEGIN {OFMT="%g %g"; print 1.5}'`, 'numeric conversion format'],
  [String.raw`awk 'BEGIN {printf "%c", -1}'`, 'character code'],
  [String.raw`awk 'BEGIN {printf "%c", 55296}'`, 'character code'],
  [String.raw`awk 'BEGIN {printf "%c", 1114112}'`, 'character code'],
  [String.raw`awk 'BEGIN {print "\xff"}'`, 'partial UTF-8 byte sequence'],
  [String.raw`awk -v x='\377' 'BEGIN {print x}'`, 'partial UTF-8 byte sequence'],
  [String.raw`awk 'BEGIN {print "é" ~ /\303\251/}'`, 'regex byte escapes'],
  [String.raw`awk 'BEGIN {print "é" ~ /[\x80-\xff]/}'`, 'regex byte escapes'],
  [String.raw`awk 'BEGIN {print "é" ~ /\w/}'`, 'locale-sensitive regex'],
  [String.raw`awk 'BEGIN {print "é" ~ /\W/}'`, 'locale-sensitive regex'],
  [String.raw`awk 'BEGIN {print "é" ~ /\y/}'`, 'locale-sensitive regex'],
  [String.raw`awk 'BEGIN {IGNORECASE=1; print "ı" ~ /i/}'`, 'locale-sensitive regex'],
  [String.raw`awk 'BEGIN {print toupper("ß")}'`, 'Unicode case mapping'],
  [String.raw`awk 'BEGIN {print tolower("İ")}'`, 'Unicode case mapping'],
  [String.raw`awk 'BEGIN {IGNORECASE=1; print index("İ","i")}'`, 'Unicode case mapping'],
  [String.raw`LC_ALL=C awk '{print length}' u`, 'byte locale text'],
  [String.raw`LC_CTYPE=POSIX awk 'BEGIN {print length("😀")}'`, 'byte locale text'],
  [String.raw`LANG=C awk 'BEGIN {printf "%c",233}'`, 'byte locale text'],
  [String.raw`LC_ALL=C awk 'BEGIN {getline x < "u"; print length(x)}'`, 'byte locale text'],
  [String.raw`LC_ALL=C awk -v x='\303\251' 'BEGIN {print length(x)}'`, 'byte locale text'],
  [String.raw`awk 'BEGIN {print "a" ~ /a{1001}/}'`, 'regex interval limit'],
  [String.raw`awk 'BEGIN {r="a{1001}";print "a" ~ r}'`, 'regex interval limit'],
  [String.raw`awk 'BEGIN {print match("",/(a{1000}){1000}/)}'`, 'regex state limit'],
  [String.raw`grep -oE '(a{1000}){1000}|' f`, 'regex state limit'],
  [String.raw`sed 's/a\{1001\}/x/' f`, 'regex interval limit'],
]

describe('diagnostic completeness — runtime and parser limitations', () => {
  for (const [command, detail] of COMMAND_GAPS) {
    it(command, () => {
      const direct = run(command)
      assert.notEqual(direct.exitCode, 0)
      assert.notEqual(direct.stderr, '')
      assert.deepEqual(direct.unsupported.map((u) => u.detail), [detail])
      const hidden = run(command + ' 2>/dev/null | true')
      assert.equal(hidden.stderr, '')
      assert.equal(hidden.exitCode, 0)
      assert.deepEqual(identity(hidden), identity(direct))
    })
  }
  for (const [command, detail] of [
    ['a=(one two)', 'array assignment'],
    ['a+=(one two)', 'array assignment'],
    ['a=(); a+=(one)', 'array assignment'],
    ['echo ${x:-default}', '${'],
    ['echo $((1+2))', '$(('],
    ['cat <(cat f)', '<('],
    ['cat f > out', '>'],
    ['while true; do cat f; done', 'while'],
    ['fn() { cat f; }; fn', 'function'],
  ]) {
    it(command, () => {
      const r = run(command)
      assert.notEqual(r.exitCode, 0)
      assert.notEqual(r.stderr, '')
      assert.deepEqual(r.unsupported.map((u) => u.detail), [detail])
    })
  }
  it('preserves output before a computed redirect fails', () => {
    const r = run(String.raw`awk 'BEGIN {print "before";x="out";print "lost" > x}' 2>/dev/null | cat`)
    assert.equal(r.stdout, 'before\n')
    assert.equal(r.stderr, '')
    assert.deepEqual(r.unsupported.map((u) => u.detail), ['output redirection'])
  })
  it('preserves output before decoding a later operand fails', () => {
    const r = run(String.raw`awk 'BEGIN {print "before"} {print}' x='\xff' f 2>/dev/null | cat`)
    assert.equal(r.stdout, 'before\n')
    assert.equal(r.stderr, '')
    assert.deepEqual(r.unsupported.map((u) => u.detail), ['partial UTF-8 byte sequence'])
  })
  it('does not report runtime gaps in unexecuted commands or branches', () => {
    for (const command of [
      'false && find . -mtime 1',
      'true || awk \'BEGIN {printf "%a", 1}\'',
      String.raw`awk 'BEGIN {if (0) printf "%a", 1; print "ok"}'`,
      String.raw`LC_ALL=C awk 'BEGINFILE {nextfile}' u`,
    ]) assert.deepEqual(run(command).unsupported, [], command)
  })
  it('does not misclassify ordinary errors as implementation limits', () => {
    for (const command of [
      'find . ! -type q', 'find . -type f,f', 'find . -maxdepth +2',
      'find . -maxdepth 2147483648', 'tree -L2147483648',
      'cut -c18446744073709551616 f', 'grep -E -F a f',
      "grep -E '[' f", "grep -E '(a' f", "grep -E '[z-a]' f",
      String.raw`grep -E '(a)\2' f`, String.raw`grep 'a\{x\}' f`,
      'grep -m1x a f', 'uniq -w-1 f', 'xargs -n0 echo',
      'a= (echo hi)', 'echo a=(one two)',
      String.raw`awk 'BEGIN {print "a" ~ /[[.ab.]]/}'`,
    ]) {
      const r = run(command)
      assert.notEqual(r.exitCode, 0, command)
      assert.deepEqual(r.unsupported, [], command)
    }
  })
  it('does not collide when diagnostic fields contain NUL delimiters', () => {
    const feed = createUnsupportedFeed()
    const first = { kind: 'feature', command: 'a\0b', detail: 'c', message: 'first' }
    const second = { kind: 'feature', command: 'a', detail: 'b\0c', message: 'second' }
    feed.add(first); feed.add(second); feed.add(first)
    assert.deepEqual(feed.entries, [first, second])
  })
})
