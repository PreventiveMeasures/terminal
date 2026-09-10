import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { 'a.txt': 'oak\n', 'b.txt': 'elm\n', 'c.txt': 'fir\n', 'sub/d.txt': 'ash\n' }

const note = (name, exitCode, skipped, search = false) =>
  `${name}: exited ${exitCode}, so ${skipped === 1 ? 'the command' : `the ${skipped} commands`} after && did not run.` +
  (search && exitCode === 1 ? ' A search that selects no lines exits 1, which is not a failure.' : '')

const notesOf = (command, files = FILES) => createTerminal(files).run(command).notes

describe('a failing command that cancels the rest of an && chain says so', () => {
  for (const [command, expected] of [
    // The three shapes this was reported for: a search that found nothing, a
    // read of a file that was not there, and a probe in front of real work.
    ["grep -n -A 75 -B 15 'nope' a.txt && cat b.txt && cat c.txt", note('grep', 1, 2, true)],
    ['cat missing.txt && cat b.txt', note('cat', 1, 1)],
    ['find abc -name f && grep -rn oak . && cat b.txt', note('find', 1, 2)],
    ['cat missing && cat b.txt && cat a.txt && cat c.txt', note('cat', 1, 3)],
    ['cd nope && ls', note('cd', 1, 1)],
    ['nosuchcmd && cat b.txt', note('nosuchcmd', 127, 1)],
    // grep separates "found nothing" from "went wrong"; only the first gets
    // the explanation, because only the first looks like success.
    ['grep nope a.txt && cat b.txt', note('grep', 1, 1, true)],
    ['grep oak missing && cat b.txt', note('grep', 2, 1)],
    ['egrep nope a.txt && cat b.txt', note('egrep', 1, 1, true)],
    ['fgrep nope a.txt && cat b.txt', note('fgrep', 1, 1, true)],
    // The blame is the command whose status the gate read.
    ['cat a.txt | grep nope && cat b.txt', note('grep', 1, 1, true)],
    ['( cat missing ) && cat b.txt', note('cat', 1, 1)],
    ['{ cat missing; } && cat b.txt', note('cat', 1, 1)],
    ['for f in missing; do cat $f; done && cat b.txt', note('cat', 1, 1)],
    // A surviving `||` branch does not undo what the `&&` gate cancelled.
    ['grep nope a.txt && cat b.txt || echo fallback', note('grep', 1, 1, true)],
  ]) {
    it(command, () => assert.deepEqual(notesOf(command), [expected]))
  }

  it('counts only the steps the gate actually skipped', () => {
    const result = createTerminal(FILES).run('cat missing && cat b.txt && cat a.txt; echo tail')
    assert.equal(result.stdout, 'tail\n')
    assert.deepEqual(result.notes, [note('cat', 1, 2)])
  })

  it('reports each chain in a line separately, and identical ones once', () => {
    assert.deepEqual(notesOf('cat missing && cat b.txt; grep nope a.txt && cat c.txt'),
      [note('cat', 1, 1), note('grep', 1, 1, true)])
    assert.deepEqual(notesOf('cat missing && cat b.txt; cat missing && cat b.txt'), [note('cat', 1, 1)])
  })
})

describe('nothing is said where the gate stopped nothing', () => {
  for (const command of [
    // The chain ran to the end.
    "grep -n 'oak' a.txt && cat b.txt && cat c.txt",
    'cat a.txt && cat b.txt',
    'true && echo yes',
    // No gate at all, or one that let the next command through.
    'cat missing.txt',
    'cat missing.txt; cat b.txt',
    'grep nope a.txt || echo none',
    'cat missing || cat b.txt',
    'true || echo skipped',
    // `!` inverts the status, so the command underneath is not what the gate read.
    '! grep oak a.txt && cat b.txt',
    '! grep nope a.txt && cat b.txt',
  ]) {
    it(command, () => assert.deepEqual(notesOf(command), []))
  }
})

describe('a command whose only product is a status is being used as intended', () => {
  for (const command of [
    '[ -f nope ] && echo yes',
    '[ -f nope ] && echo yes && echo more',
    'test -d nope && echo yes',
    '[[ -f nope ]] && echo yes',
    '[[ a == b ]] && echo yes',
    'false && echo yes',
    // -q asks for the status and nothing else, which is the same intent.
    'grep -q nope a.txt && cat b.txt',
    'grep -nq nope a.txt && cat b.txt',
    'grep -qn nope a.txt && cat b.txt',
  ]) {
    it(command, () => assert.deepEqual(notesOf(command), []))
  }

  it('still reports a search asked for with other flags', () => {
    assert.deepEqual(notesOf('grep -in nope a.txt && cat b.txt'), [note('grep', 1, 1, true)])
    assert.deepEqual(notesOf('grep -A 75 -B 15 nope a.txt && cat b.txt'), [note('grep', 1, 1, true)])
  })
})

describe('the note follows the run, not the output', () => {
  for (const command of [
    'cat missing && cat b.txt >/dev/null',
    'cat missing && cat b.txt | cat',
    'cat missing 2>/dev/null && cat b.txt',
    '( cat missing && cat b.txt )',
    '{ cat missing && cat b.txt; } 2>/dev/null',
    'value=$(cat missing && cat b.txt); true',
    'for f in a.txt; do cat missing && cat $f; done',
  ]) {
    it(command, () => {
      const result = createTerminal(FILES).run(command)
      assert.deepEqual(result.notes, [note('cat', 1, 1)])
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('says nothing when the step failed before dispatching a command', () => {
    // A refused redirect never reaches a command, so there is none to blame;
    // the refusal is already on the diagnostic feed.
    const result = createTerminal(FILES).run('cat a.txt > out && cat b.txt')
    assert.deepEqual(result.notes, [])
    assert.equal(result.unsupported.length, 1)
  })

  it('does not carry a chain into a later run', () => {
    const terminal = createTerminal(FILES)
    assert.deepEqual(terminal.run('cat missing && cat b.txt').notes, [note('cat', 1, 1)])
    assert.deepEqual(terminal.run('cat b.txt').notes, [])
    assert.deepEqual(terminal.run('cat a.txt && cat b.txt').notes, [])
  })

  it('leaves output and status exactly as they were', () => {
    const result = createTerminal(FILES).run("grep -n 'nope' a.txt && cat b.txt")
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 1)
  })
})
