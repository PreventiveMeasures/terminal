// The library's whole premise is that a command line is DATA, never
// code. Both shipping use cases hand `run()` strings nobody vetted:
// a coding agent improvising a pipeline, and a visitor typing into a
// virtual terminal embedded in a web page. Neither is a trust
// boundary we can push onto the caller — if any input could reach a
// real JS evaluator, the library would be worse than useless, since
// its selling point is that running untrusted shell text is safe.
//
// So this file pins that property from two directions:
//   1. statically — no module in `src/` contains an indirect route to
//      the Function constructor. Lint covers the direct spellings
//      (`no-eval` / `no-new-func` / `no-implied-eval`), but it cannot
//      see `({}).constructor.constructor('...')`, so that is checked
//      here as text, over every file we publish.
//   2. dynamically — with every JS evaluator in the realm swapped for
//      a recorder, a battery of hostile command lines runs to
//      completion and touches none of them.
// The two overlap on purpose: (1) catches an evaluator sitting in a
// branch no test exercises, (2) catches one reached by a spelling no
// pattern anticipated.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { createTerminal } from '@preventive/terminal'

const SOURCES = {
  'a.js': 'hello\n',
  'src/b.js': 'world\n',
}

// Command lines that read like code execution to a human — and to an
// agent that types them expecting a real shell. Every one must come
// back inert: parsed as data, rejected by the grammar, or dispatched
// to a command that does not exist. None may evaluate anything.
const HOSTILE = [
  // Direct evaluator names as argv[0].
  "eval('1+1')",
  "Function('return 1')()",
  "require('child_process')",
  "import('node:fs')",
  // Real interpreters, in the spellings shell muscle memory produces.
  "node -e 'process.exit(1)'",
  "sh -c 'id'",
  '/bin/sh -c id',
  '/usr/bin/env node',
  // Command substitution: the classic way a shell turns text into a
  // second command. This grammar has no such form.
  'echo $(whoami)',
  'echo `id`',
  'echo ${HOME}',
  'echo $HOME',
  // Reaching an evaluator through the prototype chain by naming it as
  // a command or a path — the registries are null-prototype, so these
  // are ordinary misses rather than accidental calls.
  'constructor',
  'toString',
  '__proto__',
  'cat __proto__',
  'ls constructor',
  // Commands that dispatch OTHER commands: if any of them shelled out
  // for real, this is where it would show.
  "find . -exec node -e 'x' ';'",
  'find . -exec sh -c id {} +',
  'echo a | xargs node -e',
  'echo a | xargs sh -c',
  // Background execution and subshells.
  'cat a.js & id',
  '(node -e 1)',
  'true && node -e 1 || sh -c id',
  // `for` loops are the one place a `$name` expands, and the value can
  // land in command position — where it must still hit the registry.
  'for c in "node -e 1" "sh -c id"; do $c; done',
  "for f in eval; do $f '1+1'; done",
  'for f in a; do $(id); done',
  // awk is a real language with, in every other implementation, four
  // ways to reach a shell. Each is refused by the parser.
  "awk 'BEGIN { system(\"id\") }'",
  "awk 'BEGIN { \"id\" | getline user; print user }'",
  "awk '{ print $0 | \"sh\" }' a.js",
  "awk 'BEGIN { print \"x\" > \"/etc/passwd\" }'",
  "awk -f a.js",
]

describe('no JS execution — source', () => {
  // Textual, not semantic: the point is to fail loudly the moment
  // someone types one of these into `src/`, including in a branch no
  // other test reaches. Patterns are deliberately narrow so prose in
  // comments (grep.js discusses a `Function(` search pattern) does not
  // trip them — a scanner that cries wolf gets deleted.
  const FORBIDDEN = [
    ['indirect Function constructor', /\.\s*constructor\s*(?:\.\s*constructor|\[)/u],
    ['computed constructor access', /\[\s*['"]constructor['"]\s*\]/u],
    ['globalThis indexing', /globalThis\s*\[/u],
    ['eval call', /\beval\s*\(/u],
    ['new Function', /\bnew\s+Function\b/u],
    ['dynamic import', /\bimport\s*\(/u],
    ['require', /\brequire\s*\(/u],
    ['node builtin import', /['"]node:/u],
    ['child_process', /child_process/u],
  ]

  const dir = join(import.meta.dirname, '..', 'src')
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'))

  it('publishes at least one module (guards against an empty scan passing vacuously)', () => {
    assert.ok(files.length > 5, `expected src/*.js, found ${files.length}`)
  })

  for (const file of files) {
    it(`${file} contains no route to a JS evaluator`, () => {
      const source = readFileSync(join(dir, file), 'utf8')
      for (const [label, re] of FORBIDDEN) {
        const m = re.exec(source)
        assert.equal(m, null, `src/${file}: ${label} — found ${JSON.stringify(m?.[0])}`)
      }
    })
  }

  it('has no runtime dependencies to smuggle an evaluator in through', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    assert.deepEqual(pkg.dependencies ?? {}, {})
  })
})

describe('no JS execution — runtime', () => {
  it('runs hostile input without touching any evaluator in the realm', () => {
    const t = createTerminal(SOURCES)
    const hits = []

    // Every way to turn a string into a function in this realm.
    // `Function.prototype.constructor` is the one that matters most:
    // it is what `({}).constructor.constructor` resolves to, so
    // patching it catches the indirect reach even though the global
    // `Function` binding is untouched by that route. Async and
    // generator function constructors are separate intrinsics with
    // the same power, so they get their own slots.
    const asyncCtor = Object.getPrototypeOf(async function () {}).constructor
    const genCtor = Object.getPrototypeOf(function* () {}).constructor
    const record = (name) => function (...args) {
      hits.push({ name, args })
      return () => {}
    }
    const slots = [
      [globalThis, 'eval'],
      [globalThis, 'Function'],
      [Function.prototype, 'constructor'],
      [asyncCtor.prototype, 'constructor'],
      [genCtor.prototype, 'constructor'],
    ]
    const saved = slots.map(([obj, key]) => Object.getOwnPropertyDescriptor(obj, key))

    try {
      for (const [i, [obj, key]] of slots.entries()) {
        Object.defineProperty(obj, key, { ...saved[i], value: record(key) })
      }
      // Inside this window nothing but the terminal runs, so a hit can
      // only have come from `run()`. Errors are allowed to surface as
      // return values (the terminal never throws for bad input) but a
      // throw here would still be a failure worth seeing.
      for (const line of HOSTILE) t.run(line)
    } finally {
      for (const [i, [obj, key]] of slots.entries()) {
        Object.defineProperty(obj, key, saved[i])
      }
    }

    assert.deepEqual(hits, [], `evaluator reached: ${JSON.stringify(hits)}`)
  })

  it('returns a clean result for every hostile line instead of throwing', () => {
    const t = createTerminal(SOURCES)
    for (const line of HOSTILE) {
      const r = t.run(line)
      assert.equal(typeof r.stdout, 'string', line)
      assert.equal(typeof r.stderr, 'string', line)
      assert.equal(typeof r.exitCode, 'number', line)
    }
  })

  it('has no command substitution: `$(…)`, backticks and `${…}` stay literal text', () => {
    const t = createTerminal(SOURCES)
    // Backticks are ordinary word characters here. `$HOME` / `${HOME}`
    // are variable references, but the only bindings this shell has
    // are `for` loop variables — there is no environment — so an
    // unbound name echoes back verbatim rather than naming anything.
    assert.equal(t.run('echo `id`').stdout, '`id`\n')
    assert.equal(t.run('echo ${HOME}').stdout, '${HOME}\n')
    assert.equal(t.run('echo $HOME').stdout, '$HOME\n')
    assert.equal(t.run('for x in a; do echo $HOME; done').stdout, '$HOME\n')
    // `$(` is not a substitution form; the grammar rejects the paren
    // outright rather than treating the contents as a command.
    const sub = t.run('echo $(whoami)')
    assert.notEqual(sub.exitCode, 0)
    assert.match(sub.stderr, /unexpected `\(`/u)
    // `&` would be the other way to hand work to a real process.
    assert.match(t.run('cat a.js & id').stderr, /background processes/u)
  })

  it('interpreter names are unknown commands, not passthroughs to a host shell', () => {
    const t = createTerminal(SOURCES)
    for (const line of ['node -e 1', 'sh -c id', '/bin/sh -c id', '/usr/bin/env node']) {
      const r = t.run(line)
      assert.equal(r.exitCode, 127, line)
      assert.match(r.stderr, /command not found/u, line)
      assert.equal(r.stdout, '', line)
    }
  })

  it('command dispatch cannot reach Object.prototype members', () => {
    const t = createTerminal(SOURCES)
    // The registries are `__proto__: null`, so inherited names are
    // misses (127) rather than an accidental call on a builtin.
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const r = t.run(name)
      assert.equal(r.exitCode, 127, name)
      assert.match(r.stderr, /command not found/u, name)
    }
  })

  it('awk refuses its process-spawning and file-writing forms at parse time', () => {
    const t = createTerminal(SOURCES)
    const cases = [
      ["awk 'BEGIN { system(\"id\") }'", /system\(\) is not supported: this terminal runs no processes/u],
      ["awk 'BEGIN { \"id\" | getline user }'", /command pipelines .* are not supported: this terminal runs no processes/u],
      ["awk '{ print | \"sh\" }' a.js", /output pipes .* are not supported: this terminal runs no processes/u],
      ["awk 'BEGIN { print \"x\" > \"/etc/passwd\" }'", /the filesystem is read-only/u],
    ]
    for (const [line, re] of cases) {
      const r = t.run(line)
      assert.equal(r.exitCode, 1, line)
      assert.equal(r.stdout, '', line)
      assert.match(r.stderr, re, line)
    }
    // Refused even when the statement could never run: the parser
    // rejects the program as a whole.
    assert.match(t.run("awk 'NR == -1 { system(\"id\") } { print }' a.js").stderr, /system\(\) is not supported/u)
  })

  it('find -exec and xargs dispatch through the registry, never to a host process', () => {
    const t = createTerminal(SOURCES)
    // Both are the "run another command" surfaces. An unregistered
    // name must fail closed at the registry rather than escaping.
    assert.match(t.run("find . -exec node -e 'x' ';'").stderr, /node: command not found/u)
    assert.match(t.run('echo a | xargs node -e').stderr, /node: command not found/u)
    // A loop value in command position is one unsplit word, looked up
    // as-is: `sh -c id` is a command name that does not exist.
    assert.match(t.run('for c in "sh -c id"; do $c; done').stderr, /sh -c id: command not found/u)
    // And a registered one still works, so this is failing closed
    // rather than -exec being broken outright.
    assert.equal(t.run("find . -name 'a.js' -exec echo found {} ';'").stdout, 'found ./a.js\n')
  })
})
