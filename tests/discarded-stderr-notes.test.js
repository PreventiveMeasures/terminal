import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { 'a.txt': 'oak\n', 'd1/x.js': 'a\n', 'sub/d.txt': 'ash\n' }

const hidden = (line) => `stderr: a redirect discarded ${JSON.stringify(line)}. Nothing else in this run reports that path.`
const notesOf = (command, files = FILES, opts) => createTerminal(files, opts).run(command).notes

describe('a path failure sent to /dev/null is reported anyway', () => {
  // `2>/dev/null` is written to quiet expected noise and silences a missing
  // path just as completely; the status alone cannot tell the two apart.
  it('reads as a sentence', () => {
    assert.deepEqual(notesOf('cat f 2>/dev/null | head -30'),
      ['stderr: a redirect discarded "cat: f: no such file or directory". ' +
       'Nothing else in this run reports that path.'])
  })

  for (const [command, lines] of [
    ['grep -rn a d1 d2 d3 2>/dev/null', ['grep: d2: no such file or directory', 'grep: d3: no such file or directory']],
    ['cat f 2>/dev/null | head -30', ['cat: f: no such file or directory']],
    ['ls dir/ 2>/dev/null | head -50', ['ls: dir/: no such file or directory']],
    ['cat sub 2>/dev/null', ['cat: sub: is a directory']],
    ['ls a.txt/x 2>/dev/null', ['ls: a.txt/x: not a directory']],
    ['cd nope 2>/dev/null', ['cd: nope: No such file or directory']],
    ['cd a.txt 2>/dev/null', ['cd: a.txt: Not a directory']],
    ['cat 2>/dev/null < nope', ['error: nope: No such file or directory']],
    // A closed descriptor discards just as thoroughly as /dev/null.
    ['cat nope 2>&-', ['cat: nope: no such file or directory']],
    // Hidden inside a group, a substitution, or a loop, it is still hidden.
    ['{ cat nope; } 2>/dev/null', ['cat: nope: no such file or directory']],
    ['value=$(cat nope 2>/dev/null); true', ['cat: nope: no such file or directory']],
    ['for f in nope; do cat $f; done 2>/dev/null', ['cat: nope: no such file or directory']],
  ]) {
    it(command, () => assert.deepEqual(notesOf(command), lines.map(hidden)))
  }

  it('reports a repeated failure once', () => {
    assert.deepEqual(notesOf('cat nope 2>/dev/null; cat nope 2>/dev/null'),
      [hidden('cat: nope: no such file or directory')])
  })

  it('does not carry one run into the next', () => {
    const terminal = createTerminal(FILES)
    assert.equal(terminal.run('cat nope 2>/dev/null').notes.length, 1)
    assert.deepEqual(terminal.run('cat a.txt').notes, [])
  })
})

describe('nothing is said where the caller can already see it', () => {
  for (const command of [
    // stderr reached the caller.
    'cat nope',
    'cat nope 2>&1',
    'cat nope 2>&1 | cat',
    // The last redirect wins, and it is not a discard.
    'cat nope 2>/dev/null 2>&1',
    // Redirects apply left to right, as in bash: the failure is reported
    // before `2>/dev/null` takes effect, so stderr still carries it.
    'cat < nope 2>/dev/null',
    // Nothing failed, or nothing failed on a path.
    'cat a.txt 2>/dev/null',
    'grep nope a.txt 2>/dev/null',
    'grep --unknown x a.txt 2>/dev/null',
    'shopt -s nullglob 2>/dev/null',
  ]) {
    it(command, () => assert.deepEqual(notesOf(command).filter((n) => n.startsWith('stderr:')), []))
  }

  it('says nothing when the same diagnostic reaches stderr elsewhere in the run', () => {
    assert.deepEqual(notesOf('cat nope 2>/dev/null; cat nope'), [])
  })

  it('says nothing when another note already accounts for the path', () => {
    // The cwd note names the same path and says more about it.
    const result = createTerminal({ file: 'x\n', 'sub/keep': '' }, { mount: '/repo', cwd: '/repo/sub' })
      .run('cat file 2>/dev/null')
    assert.deepEqual(result.notes, ['cat: relative path "file" was not found from cwd "/repo/sub". A file exists at "/repo/file".'])
  })

  it('says nothing when stderr goes somewhere the caller can read', () => {
    const terminal = createTerminal({ 'a.txt': 'oak\n' }, { mount: '/repo', cwd: '/repo', writable: '/tmp/' })
    const result = terminal.run('cat nope 2>/tmp/err')
    assert.deepEqual(result.notes, [])
    assert.equal(terminal.run('cat /tmp/err').stdout, 'cat: nope: no such file or directory\n')
  })
})

describe('the note leaves the run itself alone', () => {
  it('changes neither output nor status', () => {
    const result = createTerminal(FILES).run('grep -rn a d1 d2 d3 2>/dev/null')
    assert.equal(result.stdout, 'd1/x.js:1:a\n')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 2)
    assert.deepEqual(result.unsupported, [])
  })

  it('sits alongside whatever else the run had to say', () => {
    assert.deepEqual(createTerminal(FILES).run('cat nope 2>/dev/null && cat a.txt').notes, [
      'cat: exited 1, so the command after && did not run.',
      hidden('cat: nope: no such file or directory'),
    ])
  })
})
