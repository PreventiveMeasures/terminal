import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed 4.9 compile.c mark_subst_opts accepts repeated i/I and combines
// REG_ICASE with ordinary substitution options; regexp.c retains the flags
// when an empty regex reuses the last pattern.
// https://github.com/mirror/sed/blob/v4.9/sed/compile.c
// https://github.com/mirror/sed/blob/v4.9/sed/regexp.c
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const expected = (stdout = '', exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode, cwd: '/', notes: [], unsupported: [] })
// A writable overlay needs a mount away from `/`, and cwd follows the mount.
const mounted = (...args) => ({ ...expected(...args), cwd: '/src' })
const run = (script, input, flags = '') => createTerminal({ input }).run(`sed ${flags} ${quote(script)} input`)

describe('sed case-insensitive substitution flags', () => {
  for (const modifier of ['i', 'I', 'ii', 'II', 'iI', 'Ii', 'i I']) {
    it(`accepts modifier ${modifier}`, () => {
      assert.deepEqual(run(`s/alpha/X/${modifier}`, 'ALPHA alpha\nAlpha\n'), expected('X alpha\nX\n'))
    })
  }

  const cases = [
    ['global matches', 's/a/X/ig', 'aAba\n', 'XXbX\n'],
    ['uppercase global flags', 's/a/X/gI', 'aAba\n', 'XXbX\n'],
    ['print successful substitutions', 's/a/X/Ip', 'A\nb\n', 'X\n', '-n'],
    ['numeric occurrence', 's/a/X/2i', 'AaA\n', 'AXA\n'],
    ['numeric global occurrence', 's/a/X/I2g', 'AaA\n', 'AXX\n'],
    ['range character folding', 's/[a-z]/X/ig', 'aAzZ0\n', 'XXXX0\n'],
    ['negated character folding', 's/[^a]/X/ig', 'AaBb\n', 'AaXX\n'],
    ['POSIX lower class folding', 's/[[:lower:]]/X/ig', 'aAzZ0\n', 'XXXX0\n'],
    ['whole match preserves original case', 's/ab/[&]/ig', 'aB AB ab\n', '[aB] [AB] [ab]\n'],
    ['BRE capture preserves original case', String.raw`s/\(ab\)/[\1]/i`, 'AB\n', '[AB]\n'],
    ['ERE capture preserves original case', String.raw`s/(ab)/[\1]/I`, 'aB\n', '[aB]\n', '-E'],
    ['POSIX longest alternative', String.raw`s/(a|ab)/[\1]/i`, 'AB\n', '[AB]\n', '-E'],
    ['word assertions', String.raw`s/\<abc\>/X/ig`, 'ABC xAbC abc\n', 'X xAbC X\n'],
    ['line addresses stay case-sensitive', '/a/s/a/X/i', 'A\na\n', 'A\nX\n'],
    ['i does not change multiline dot matching', 'N;s/a.b/X/i', 'A\nB\n', 'X\n'],
    ['i does not change multiline anchors', 'N;s/^b/X/i', 'a\nB\n', 'a\nB\n'],
    ['NUL record separators', 's/a/X/ig', 'a\0A\0', 'X\0X\0', '-z'],
    ['replacement equality still triggers branching', 's/a/A/i;t hit;s/.*/miss/;:hit', 'A\n', 'A\n'],
    ['a later case-sensitive regex resets matching mode', 's/a/a/i;s/a/X/g', 'AaA\n', 'XXA\n'],
    ['empty regex retains the previous case mode', 's/a/a/i;s//X/g', 'AaA\n', 'XXX\n'],
    ['previous case mode persists across print addresses', 's/a/a/i;//p', 'A\n', 'a\n', '-n'],
  ]
  for (const [name, script, input, stdout, flags] of cases) {
    it(name, () => assert.deepEqual(run(script, input, flags), expected(stdout)))
  }

  it('uses the same behavior for script files and multiple expressions', () => {
    const t = createTerminal({ input: 'AaA\n', program: 's/a/a/I\n' })
    assert.deepEqual(t.run("sed -f program -e 's//X/g' input"), expected('XXX\n'))
  })

  it('writes once per successful case-insensitive substitution', () => {
    const t = createTerminal({ input: 'AaA\nb\n' }, { mount: '/src/', writable: '/tmp/' })
    assert.deepEqual(t.run("sed -n 's/a/X/Igpw /tmp/out' /src/input"), mounted('XXX\n'))
    assert.deepEqual(t.run('cat /tmp/out'), mounted('XXX\n'))
  })
})

describe('sed uppercase I regex address modifier', () => {
  for (const script of ['/a/Ip', '/a/ I p', '/a/IIp', String.raw`\#a#Ip`]) {
    it(script, () => assert.deepEqual(run(script, 'A\nb\na\n', '-n'), expected('A\na\n')))
  }

  const cases = [
    ['/a/I!p', 'A\nb\n', 'b\n'],
    ['/a/I,/end/Ip', 'A\nbody\nEND\noutside\n', 'A\nbody\nEND\n'],
    ['/a/Is//X/', 'A\nb\n', 'X\nb\n', ''],
    [String.raw`/\(a\)/Is//[\1]/`, 'A\n', '[A]\n', ''],
    ['/a/I{p;}', 'A\nb\n', 'A\n'],
  ]
  for (const [script, input, stdout, flags = '-n'] of cases) {
    it(script, () => assert.deepEqual(run(script, input, flags), expected(stdout)))
  }
})

describe('sed regex flag errors and engine limitations', () => {
  for (const flag of ['i', 'I', 'm', 'M']) {
    for (const input of ['', 'a\n']) {
      it(`empty regex with ${flag} fails before processing ${JSON.stringify(input)}`, () => {
        assert.deepEqual(run(`s/a/A/;s//X/${flag}`, input), expected('', 1, 'sed: cannot specify modifiers on empty regexp\n'))
      })
    }
  }

  it('opens w targets before rejecting modifiers on an empty regex', () => {
    const t = createTerminal({ input: 'a\n' }, { mount: '/src/', writable: '/tmp/' })
    assert.deepEqual(t.run('printf old >/tmp/out'), mounted())
    assert.deepEqual(t.run("sed 's//X/Iw /tmp/out' /src/input"), mounted('', 1, 'sed: cannot specify modifiers on empty regexp\n'))
    assert.deepEqual(t.run('cat /tmp/out'), mounted())
  })

  it('reports invalid flags before checking whether the regex is empty', () => {
    assert.deepEqual(run('s//X/iQ', ''), expected('', 1, "sed: unknown option to substitute command: 'Q'\n"))
  })

  for (const flag of ['m', 'M', 'e']) {
    it(`reports the actual unsupported flag ${flag}`, () => {
      const feature = flag === 'e' ? 'command evaluation' : 'multiline regex matching'
      const message = `sed: substitution flag '${flag}' (${feature}) is not supported`
      const unsupported = [{ kind: 'feature', command: 'sed', detail: `substitution flag ${flag}`, message }]
      const t = createTerminal({ input: 'a\n' })
      assert.deepEqual(t.run(`sed 's/a/X/${flag}' input`), { ...expected('', 1, message + '\n'), unsupported })
      assert.deepEqual(t.run(`sed 's/a/X/${flag}' input 2>/dev/null | cat`), { ...expected(), unsupported })
    })
  }

  for (const [script, input] of [
    ['s/k/X/i', 'K\n'], ['s/é/X/I', 'É\n'], ['s/a/X/i', 'aé\n'],
    ['/k/Ip', 'K\n'], [String.raw`s/(a)|(b)/\1/i`, 'A\n'],
  ]) {
    it(`preserves regex engine diagnostics: ${script}`, () => {
      const t = createTerminal({ input })
      const result = t.run(`sed -E ${quote(script)} input`)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 1)
      assert.equal(result.unsupported.length, 1)
      assert.equal(result.unsupported[0].detail, script.includes('(a)') ? 'regex capture semantics' : 'non-ASCII regex semantics')
      assert.deepEqual(t.run(`sed -E ${quote(script)} input 2>/dev/null | cat`), { ...expected(), notes: [], unsupported: result.unsupported })
    })
  }
})
