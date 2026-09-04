import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTerminal } from '@preventive/terminal'

const SOURCES = {
  'src/foo.js': 'const x = 1\n',
  'node_modules/dep/index.js': 'y\n',
  'f.txt': 'b 2\na 1\n',
}

const term = () => createTerminal(SOURCES)
const gaps = (line, t = term()) => t.run(line).unsupported
const details = (line, t = term()) => gaps(line, t).map((u) => u.detail)

describe('run().unsupported — the case it exists for', () => {
  // The report that prompted the channel. `-prune` was missing, find
  // said so on stderr, `2>/dev/null` ate the message, and `head`
  // replaced the exit code. An unimplemented option was indistinguishable
  // from an empty tree. `-prune` works now, so this uses another option
  // find does not have — the shape is what matters, not the spelling.
  it('survives the redirect-and-pipe that hid it: empty stderr, exit 0, gap still reported', () => {
    const r = term().run('find . -newer ref 2>/dev/null | head -50')
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '', 'the message really is gone from stderr')
    assert.equal(r.exitCode, 0, "head's status really did replace find's")
    assert.deepEqual(r.unsupported, [{
      kind: 'option',
      command: 'find',
      detail: '-newer',
      message: 'find: unknown option: -newer',
    }])
  })

  it('is not suppressible by any of the shell plumbing', () => {
    // Each of these silences or overrides the command's own channels.
    for (const line of [
      'ls -t 2>/dev/null',
      'ls -t >/dev/null 2>&1',
      'ls -t 2>&1 | grep -c nothing',
      'ls -t || true',
      'false && ls -t || ls -t',
      '(ls -t) 2>/dev/null',
      'echo a | (ls -t) 2>/dev/null | wc -l',
    ]) {
      assert.deepEqual(details(line), ['-t'], line)
    }
  })

  it('reports gaps hit through find -exec and xargs, two levels down', () => {
    // `';'` rather than the GNU-canonical `\;`: this shell parser does
    // not honor backslash escapes outside quotes, a pre-existing
    // limitation with its own todo test in terminal.test.js.
    assert.deepEqual(details("find . -name '*.js' -exec frobnicate {} ';' 2>/dev/null"), ['frobnicate'])
    assert.deepEqual(details("find . -name '*.js' -exec frobnicate {} + 2>/dev/null"), ['frobnicate'])
    assert.deepEqual(details('echo hi | xargs frobnicate 2>/dev/null'), ['frobnicate'])
  })
})

describe('run().unsupported — what counts as a gap', () => {
  it('kind `command`: a name that is not registered', () => {
    const [u] = gaps('frobnicate')
    assert.equal(u.kind, 'command')
    assert.equal(u.command, 'frobnicate')
    assert.equal(u.detail, 'frobnicate')
    assert.match(u.message, /^frobnicate: command not found\./u)
    // The name as TYPED, so a bin-prefixed miss is reported as written.
    assert.deepEqual(details('/usr/bin/frobnicate'), ['/usr/bin/frobnicate'])
  })

  it('kind `option`: a registered command handed an option it lacks', () => {
    // Short, long, and bundled forms all route through parseArgs, which
    // does not know whose tokens it has — the dispatcher supplies the name.
    assert.deepEqual(gaps('ls -t'), [{
      kind: 'option', command: 'ls', detail: '-t', message: 'ls: unknown option: -t',
    }])
    assert.deepEqual(gaps('wc --bogus f.txt'), [{
      kind: 'option', command: 'wc', detail: '--bogus', message: 'wc: unknown option: --bogus',
    }])
    assert.deepEqual(details('ls -at'), ['-t'], 'a bundle reports the offending char')
  })

  it('kind `option`: an option a command parses and then explicitly rejects', () => {
    assert.deepEqual(gaps('tr -d -s a'), [{
      kind: 'option', command: 'tr', detail: '-d -s',
      message: 'tr: -d combined with -s is not supported',
    }])
    assert.deepEqual(details('find . -not -exec echo {} + '), ['-not -exec ... +'])
  })

  it('kind `feature`: shell constructs the parser recognizes and refuses', () => {
    assert.deepEqual(details('sleep 1 &'), ['&'])
    assert.deepEqual(details('cat f.txt > out.txt'), ['>'])
    assert.deepEqual(details('cat f.txt >> out.txt'), ['>>'])
    assert.deepEqual(details('cat f.txt 2>> out.txt'), ['2>>'])
    // Shell-level gaps have no command to name.
    assert.equal(gaps('sleep 1 &')[0].command, null)
    assert.equal(gaps('sleep 1 &')[0].kind, 'feature')
  })

  it('kind `feature`: sed funnels every way out of its subset into one entry', () => {
    // An unknown flag, a missing -n, and a regex address are all the
    // same "this is not a real sed" to a caller deciding whether to use it.
    for (const line of ["sed -e s/a/b/ f.txt", "sed '1,2p' f.txt", "sed -n 's/a/b/' f.txt"]) {
      assert.deepEqual(details(line), ['script'], line)
      assert.equal(gaps(line)[0].command, 'sed')
    }
  })

  it('a plain failure is not a gap — GNU fails the same way', () => {
    for (const line of [
      'cat missing.txt',      // unreadable operand
      'grep nomatch f.txt',   // no match
      'cd nowhere',           // not a directory
      'ls missing',
      'head -n x f.txt',      // invalid count
      'wc -l missing',
      'tr a',                 // wrong operand count
      'grep -e',              // stranded value option
      'grep --include',       // stranded long value option
      'grep -l -c f.txt',     // mutually exclusive modes
      'sort -k0 f.txt',       // field number zero
      'find . -name',         // primary missing its value
      'find . -type q',       // bad primary value
      'echo a >',             // redirect with no target
      ')',                    // syntax error
      'cat |',                // empty pipeline stage
    ]) {
      const r = term().run(line)
      assert.deepEqual(r.unsupported, [], line)
      assert.notEqual(r.exitCode, 0, `${line} should still fail`)
    }
  })

  it('reports nothing for lines that work — no phantom gaps', () => {
    // The `-NUM` shorthands and the digit options that share their
    // syntax are the ones worth pinning: they are the reason parseArgs
    // has a schema-aware numeric guard at all.
    for (const line of [
      'head -2 f.txt', 'ls -10', 'tail -1 f.txt',
      'find . -name "*.txt" -print0 | xargs -0 wc -l',
      'sort -k2n f.txt', 'sort -t" " -k1,1 f.txt',
      'cat f.txt | tr -c "a-z" .', 'uniq -f1 f.txt',
      "sed -n '1,2p' f.txt", 'cat -A f.txt', 'seq -w 8 11',
      'find . -name node_modules -prune -o -print',
    ]) {
      assert.deepEqual(gaps(line), [], line)
    }
  })

  it('reports a gap and an ordinary error in the same line on their own channels', () => {
    const r = term().run('cat missing.txt; ls -t')
    assert.match(r.stderr, /no such file or directory/u)
    assert.match(r.stderr, /unknown option: -t/u)
    assert.deepEqual(r.unsupported.map((u) => u.detail), ['-t'])
  })

  it('separates "GNU has it, we do not" from "nobody has it"', () => {
    // sort's key modifiers are the sharp case: `g` is real GNU we do not
    // model, `Z` is malformed for GNU too. Reporting both as gaps would
    // train a caller to read its own typos as missing features.
    assert.deepEqual(details('sort -k2g f.txt'), ['-k2g'])
    assert.deepEqual(gaps('sort -k2Z f.txt'), [])
    // A character offset is valid GNU that this sort does not model.
    assert.deepEqual(details('sort -k1.2 f.txt'), ['-k1.2'])
    assert.deepEqual(gaps('sort -k1,2,3 f.txt'), [], 'a malformed spec is just an error')
    // Both still fail identically on the command's own channels.
    assert.equal(term().run('sort -k2g f.txt').exitCode, 1)
    assert.equal(term().run('sort -k2Z f.txt').exitCode, 1)
  })
})

describe('run().unsupported — the contract', () => {
  it('is always present, and empty when nothing was missing', () => {
    for (const line of ['', 'ls', 'cat f.txt | wc -l', 'find . -name "*.js"']) {
      assert.deepEqual(term().run(line).unsupported, [], line)
    }
  })

  it('leaves stderr and the exit code exactly as they were', () => {
    // The whole point is that this is an ADDITIONAL channel: an
    // interactive user must still see the message.
    const r = term().run('ls -t')
    assert.equal(r.stderr, 'ls: unknown option: -t\n')
    assert.equal(r.exitCode, 1)
    assert.equal(term().run('frobnicate').exitCode, 127, 'command-not-found keeps its 127')
    assert.equal(term().run('grep -P foo f.txt').exitCode, 2, "grep keeps its own usage exit 2")
    // The entry's message is that stderr line, minus the stream newline.
    assert.equal(r.unsupported[0].message + '\n', r.stderr)
  })

  it('deduplicates: one entry per distinct gap, however many times it is hit', () => {
    const r = term().run('frobnicate; frobnicate; frobnicate')
    assert.equal(r.unsupported.length, 1)
    assert.equal(r.stderr.split('\n').filter(Boolean).length, 3, 'stderr still shows all three')
    // Distinct gaps stay distinct, in the order first hit.
    assert.deepEqual(details('ls -t; frobnicate; wc --bogus f.txt; ls -t'), ['-t', 'frobnicate', '--bogus'])
  })

  it('is per-run, not cumulative', () => {
    const t = term()
    assert.deepEqual(details('ls -t', t), ['-t'])
    assert.deepEqual(gaps('ls', t), [], 'the next run starts clean')
    assert.deepEqual(details('frobnicate', t), ['frobnicate'])
  })

  it('is frozen, entries included', () => {
    const r = term().run('ls -t')
    assert.equal(Object.isFrozen(r.unsupported), true)
    assert.equal(Object.isFrozen(r.unsupported[0]), true)
    assert.throws(() => r.unsupported.push({}), TypeError)
  })

  it('is plain data: JSON-safe and structured-clonable, with no hidden passengers', () => {
    // The classification rides a symbol internally; none of it may reach
    // the caller, who may be sending this across a worker or tool-call
    // boundary.
    const r = term().run('ls -t')
    assert.deepEqual(Object.getOwnPropertySymbols(r), [])
    assert.deepEqual(Object.getOwnPropertySymbols(r.unsupported[0]), [])
    assert.deepEqual(Object.keys(r).sort(), ['cwd', 'exitCode', 'stderr', 'stdout', 'unsupported'])
    assert.deepEqual(JSON.parse(JSON.stringify(r.unsupported[0])), {
      kind: 'option', command: 'ls', detail: '-t', message: 'ls: unknown option: -t',
    })
    structuredClone(r.unsupported[0])
  })
})

describe('run().unsupported — wired commands', () => {
  it('reports a wired command\'s unknown option like a built-in\'s', () => {
    // A wired handler that throws is an ordinary failure, not a gap:
    // only this package can say what this package fails to implement.
    const t = createTerminal(SOURCES, { commands: { probe: () => { throw new Error('unknown option: -z') } } })
    assert.deepEqual(t.run('probe -z').unsupported, [])
    assert.equal(t.run('probe -z').stderr, 'probe: unknown option: -z\n')
  })

  it('survives a handler that throws a non-Error, including a hostile one', () => {
    // Harvesting the classification means READING a property off the
    // thrown value, so every shape that made index.js's `reason` careful
    // applies here too: `null` has no properties, and a proxy can throw
    // from the getter itself.
    const thrower = (value) => () => { throw value }
    const t = createTerminal(SOURCES, {
      commands: {
        nul: thrower(null),
        str: thrower('oops'),
        hostile: thrower(new Proxy({}, { get() { throw new Error('nope') } })),
      },
    })
    for (const name of ['nul', 'str', 'hostile']) {
      const r = t.run(name)
      assert.deepEqual(r.unsupported, [], name)
      assert.equal(r.exitCode, 1, name)
    }
  })

  it('keeps the feeds apart when a handler re-enters run()', () => {
    // Same isolation runGroup gives the cwd: each run reports the gaps
    // hit beneath it, to whoever made that call.
    let inner = null
    const t = createTerminal(SOURCES, { commands: { probe: () => { inner = t.run('ls -t'); return 'ok\n' } } })
    const outer = t.run('probe; frobnicate')
    assert.deepEqual(inner.unsupported.map((u) => u.detail), ['-t'])
    assert.deepEqual(outer.unsupported.map((u) => u.detail), ['frobnicate'])
  })
})
