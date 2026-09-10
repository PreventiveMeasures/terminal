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
import { join, sep } from 'node:path'
import { describe, it } from 'node:test'

import { createTerminal } from '@preventive/terminal'

const SOURCES = {
  'a.js': 'hello\n',
  'src/b.js': 'world\n',
  // Program text arriving as data, for `awk -f`.
  'prog.awk': 'BEGIN { print "from a program file" }\n',
}

// Command lines that read like code execution to a human — and to an
// agent that types them expecting a real shell. Every one must come
// stay inside the virtual interpreter or return an error. None may
// evaluate JavaScript or launch a host command.
const HOSTILE = [
  // Direct evaluator names as argv[0].
  "eval('1+1')",
  "Function('return 1')()",
  "require('child_process')",
  "import('node:fs')",
  "printf 'eval(\"1+1\")' | base64 | base64 -d",
  "printf 'ZXZhbA==KA==MQ==KQ==' | base64 -d",
  // Real interpreters, in the spellings shell muscle memory produces.
  "node -e 'process.exit(1)'",
  "sh -c 'id'",
  '/bin/sh -c id',
  '/usr/bin/env node',
  // Substitution still dispatches through the virtual command registry.
  'echo $(whoami)',
  "echo $(node -e 'process.exit(1)')",
  "x=$(sh -c id); echo \"$x\"",
  "echo \"$(echo \"$(node -e 'process.exit(1)')\")\"",
  'if true; then echo $(whoami); else node -e 1; fi',
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
  // An expanded value can land in command position and must still hit
  // the registry.
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
  // The same reaches, spelled so the operand is a string only at
  // runtime: a computed command, a coprocess, a computed redirect
  // target, and gawk's indirect call through a name held in a variable.
  "awk 'BEGIN { cmd = \"id\"; cmd | getline x }'",
  "awk 'BEGIN { print \"x\" |& \"sh\" }'",
  "awk 'BEGIN { f = \"/tmp/pwn\"; print \"x\" > f }'",
  "awk 'BEGIN { f = \"system\"; @f(\"id\") }'",
  "awk 'function system(c) { return 1 } BEGIN { system(\"id\") }'",
  // Program text as data: from a file in the virtual FS, from `-v`,
  // and under names that are evaluators in JS but not in awk.
  'awk -f prog.awk a.js',
  "awk -v x='BEGIN{system(\"id\")}' 'BEGIN { print x }'",
  "awk 'BEGIN { print eval(\"1+1\"), Function(\"return 1\")() }'",
  // Subscripts are attacker-chosen strings that must stay keys.
  "awk 'BEGIN { a[\"__proto__\"] = 1; a[\"constructor\"] = 2; for (k in a) print k }'",
  // getline reads the virtual FS, never the host's.
  "awk 'BEGIN { while ((getline l < \"/etc/passwd\") > 0) print l }'",
]

describe('no JS execution — source', () => {
  // Textual, not semantic: the point is to fail loudly the moment
  // someone types one of these into `src/`, including in a branch no
  // other test reaches. Each pattern is as wide as it can be without
  // matching what `src/` legitimately says — a scanner that cries wolf
  // gets deleted, so `catches the evasions it exists for` below pins
  // both halves of that trade with worked examples.
  const FORBIDDEN = [
    // No module has a reason to read `.constructor` at all, so the
    // whole property is refused rather than only the double hop: an
    // alias split over two statements (`const c = x.constructor` …
    // `c.constructor(src)`) reads as innocent one line at a time.
    ['constructor access', /\.\s*constructor\b/u],
    ['computed constructor access', /\[\s*['"]constructor['"]\s*\]/u],
    ['globalThis', /\bglobalThis\b/u],
    ['eval call', /\beval\s*\(/u],
    // `Function(src)` evaluates without `new`, and the async, generator
    // and async-generator constructors are separate intrinsics reached
    // as `new AsyncFunction(src)` once bound to a local name.
    ['Function constructor', /\bFunction\s*[([.]/u],
    ['new Function', /\bnew\s+[A-Za-z_$.]*Function\b/u],
    ['dynamic import', /\bimport\s*\(/u],
    ['require', /\brequire\s*\(/u],
    ['node builtin import', /['"]node:/u],
    ['child_process', /child_process/u],
    // `process.binding` / `process.mainModule.require` are the host
    // escapes. Requiring an identifier after the dot keeps prose ("spawn
    // a host process.") from tripping the scan.
    ['process object', /\bprocess\s*\.\s*[A-Za-z_$]/u],
    // A string first argument to a timer is an evaluator by another name.
    ['timer with a string body', /\bset(?:Timeout|Interval|Immediate)\s*\(\s*['"`]/u],
  ]

  const dir = join(import.meta.dirname, '..', 'src')
  const files = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => f.split(sep).join('/')).sort()

  it('publishes at least one module (guards against an empty scan passing vacuously)', () => {
    assert.ok(files.length > 5, `expected src/**/*.js, found ${files.length}`)
  })

  it('audits every packaged runtime module, including subdirectories', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    const packaged = pkg.files.filter((file) => file.endsWith('.js')).sort()
    assert.deepEqual(files.map((file) => 'src/' + file), packaged)
    for (const subdir of ['awk', 'commands', 'shell']) assert.ok(files.some((file) => file.startsWith(subdir + '/')), subdir)
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

  // A scan is only worth its runtime if it catches what it claims to,
  // and only survives if it stays quiet on honest code. Both lists are
  // real: the evasions are spellings the narrower patterns this file
  // shipped with let through, the benign lines are shapes taken from
  // `src/` as it stands.
  it('catches the evasions it exists for, and nothing src/ legitimately says', () => {
    const EVASIONS = [
      "({}).constructor.constructor('return 1')()",
      'const c = x.constructor; c.constructor(src)()',
      "const f = obj['constructor']; f(src)",
      "Function('return this')()",
      'Function.prototype.constructor(src)',
      'new Function(src)',
      'const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor',
      'globalThis.eval(src)',
      "globalThis['ev' + 'al'](src)",
      "await import('node:child_process')",
      "require('child_process').execSync(cmd)",
      "process.binding('spawn_sync')",
      "process.mainModule.require('fs')",
      "setTimeout('id()', 0)",
    ]
    for (const line of EVASIONS) {
      assert.ok(FORBIDDEN.some(([, re]) => re.test(line)), `evasion not caught: ${line}`)
    }
    const BENIGN = [
      'class Signal extends Error {\n  constructor(signal) { super(signal.type) }\n}',
      '// No program evaluation can execute JavaScript or spawn a host process.',
      'function parseFunction(p, program) {}',
      "if (typeof value === 'function') return { run: value }",
      '// process substitution (`<(…)`) is not supported',
      "import { AwkError } from './common.js'",
      'setTimeout(fn, 0)',
    ]
    for (const line of BENIGN) {
      const hit = FORBIDDEN.find(([, re]) => re.test(line))
      assert.equal(hit, undefined, `false positive (${hit?.[0]}): ${line}`)
    }
  })

  it('limits runtime dependencies to the byte codecs', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ['@exodus/bytes'])
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
    // `Function` binding is untouched by that route. Async, generator
    // and async-generator function constructors are separate intrinsics
    // with the same power, so they get their own slots.
    const asyncCtor = Object.getPrototypeOf(async function () {}).constructor
    const genCtor = Object.getPrototypeOf(function* () {}).constructor
    const asyncGenCtor = Object.getPrototypeOf(async function* () {}).constructor
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
      [asyncGenCtor.prototype, 'constructor'],
      // A timer called with a string body evaluates it. Nothing but the
      // terminal runs inside this window and it is synchronous
      // throughout, so standing in for the timers costs nothing.
      [globalThis, 'setTimeout'],
      [globalThis, 'setInterval'],
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

  it('runs command substitution through the virtual registry and rejects unsupported expansion forms', () => {
    const t = createTerminal(SOURCES)
    assert.deepEqual(t.run('echo "$(cat a.js)"'), {
      stdout: 'hello\n', stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
    })
    assert.deepEqual(t.run('echo $((1+1))'), {
      stdout: '2\n', stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
    })
    for (const line of ['echo `id`', 'echo $[1+1]']) {
      const r = t.run(line)
      assert.equal(r.exitCode, 1, line)
      assert.equal(r.stdout, '', line)
      assert.match(r.stderr, /not supported/u, line)
      assert.equal(r.unsupported[0].kind, 'feature', line)
    }
    for (const line of ["echo $(node -e 'process.exit(1)')", 'x=$(sh -c id)', 'echo "$(/bin/sh -c id)"']) {
      const r = t.run(line)
      assert.match(r.stderr, /command not found/u, line)
      assert.equal(r.unsupported[0].kind, 'command', line)
    }
    // `$NAME` / `${NAME}` are variable references, and the only bindings
    // this shell has are its own (`for` variables, assignments, and the
    // few names it answers itself) — there is no environment behind them.
    assert.equal(t.run('echo ${PATH}').stdout, '\n')
    assert.equal(t.run('for x in a; do echo $SHELL; done').stdout, '\n')
    assert.equal(t.run('echo $HOME').stdout, '/\n')
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

  it('awk refuses the same reaches when the operand is a string only at runtime', () => {
    const t = createTerminal(SOURCES)
    // A command name held in a variable is still a pipeline to a process.
    assert.match(t.run("awk 'BEGIN { cmd = \"id\"; cmd | getline x }'").stderr, /command pipelines .* are not supported/u)
    // gawk's coprocess operator, which the four literal forms do not cover.
    assert.match(t.run("awk 'BEGIN { print \"x\" |& \"sh\" }'").stderr, /output pipes .* are not supported/u)
    // A redirect target the parser cannot read as a literal is checked
    // again where it becomes a string, so it fails at runtime instead.
    const redirect = t.run("awk 'BEGIN { f = \"/tmp/pwn\"; print \"x\" > f }'")
    assert.equal(redirect.exitCode, 2)
    assert.equal(redirect.stdout, '')
    assert.match(redirect.stderr, /the filesystem is read-only/u)
    // `@f(...)` would make a builtin's name a value, and a user function
    // cannot take a refused builtin's name to smuggle the call past the
    // parse-time check either.
    assert.match(t.run("awk 'BEGIN { f = \"system\"; @f(\"id\") }'").stderr, /indirect calls .* are not supported/u)
    assert.match(t.run("awk 'function system(c) { return 1 } BEGIN { system(\"id\") }'").stderr, /cannot redefine builtin function `system`/u)
    // Only awk's three device names are writable; everything else is
    // refused rather than reaching a real file.
    assert.equal(t.run("awk 'BEGIN { print \"x\" > \"/dev/stderr\" }'").stderr, 'x\n')
  })

  it('awk program text is data at every entry point, and awk is the only thing that reads it', () => {
    const t = createTerminal(SOURCES)
    // A program from `-f` comes out of the virtual FS and goes to awk's
    // own parser, exactly like one typed as an operand.
    assert.equal(t.run('awk -f prog.awk a.js').stdout, 'from a program file\n')
    // `-v` and operand assignments carry values, never programs: this
    // one is printed, not run.
    assert.equal(t.run("awk -v x='BEGIN{system(\"id\")}' 'BEGIN { print x }'").stdout, 'BEGIN{system("id")}\n')
    // Names that are evaluators in JS are undefined awk functions, and
    // an undefined function is a parse error, not a lookup at runtime.
    for (const name of ['eval', 'Function', 'require', 'constructor']) {
      const r = t.run(`awk 'BEGIN { print ${name}("1+1") }'`)
      assert.equal(r.exitCode, 1, name)
      assert.equal(r.stdout, '', name)
      assert.match(r.stderr, new RegExp(`function \`${name}\` is never defined`, 'u'), name)
    }
    // `getline < file` reads the virtual FS: a host path is simply
    // absent (-1), not opened.
    assert.equal(t.run("awk 'BEGIN { print (getline l < \"/etc/passwd\") }'").stdout, '-1\n')
    assert.equal(t.run("awk 'BEGIN { while ((getline l < \"a.js\") > 0) print l }'").stdout, 'hello\n')
  })

  it('awk arrays are prototype-free: Object.prototype names are ordinary keys', () => {
    const t = createTerminal(SOURCES)
    // Subscripts come from input, so they are attacker-chosen. Held in
    // a Map, they are keys; in a plain object, `a["__proto__"] = ...`
    // would reach Object.prototype instead of the array.
    const r = t.run("awk 'BEGIN { a[\"__proto__\"] = 1; a[\"constructor\"] = 2; a[\"toString\"] = 3; for (k in a) print k, a[k] }'")
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, '__proto__ 1\nconstructor 2\ntoString 3\n')
    // A fresh array inherits none of it, and an unset element is empty
    // rather than an inherited member.
    assert.equal(t.run("awk 'BEGIN { a[\"__proto__\"] = 1; print length(b), ((\"__proto__\" in b) ? \"yes\" : \"no\") }'").stdout, '0 no\n')
    assert.equal(t.run("awk 'BEGIN { print length(a[\"toString\"]) }'").stdout, '0\n')
  })

  it('find -exec and xargs dispatch through the registry, never to a host process', () => {
    const t = createTerminal(SOURCES)
    // Both are the "run another command" surfaces. An unregistered
    // name must fail closed at the registry rather than escaping.
    assert.match(t.run("find . -exec node -e 'x' ';'").stderr, /node: command not found/u)
    assert.match(t.run('echo a | xargs node -e').stderr, /node: command not found/u)
    // A loop value in command position is word-split like bash splits
    // it: `sh` is a command name that does not exist, `-c id` its args.
    assert.match(t.run('for c in "sh -c id"; do $c; done').stderr, /^sh: command not found/u)
    assert.match(t.run('for c in "sh -c id"; do "$c"; done').stderr, /^sh -c id: command not found/u)
    // And a registered one still works, so this is failing closed
    // rather than -exec being broken outright.
    assert.equal(t.run("find . -name 'a.js' -exec echo found {} ';'").stdout, 'found ./a.js\n')
  })
})
