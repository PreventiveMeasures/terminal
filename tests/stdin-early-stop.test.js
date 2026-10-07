import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// The commands of a group share one stdin. A reader that stops before its
// end leaves the rest to the next one — but GNU's tools read a pipe a buffer
// at a time, and how much more than they needed a read had taken depends on
// how the writer's writes fell between them: `seq 1 3000 | { head -n 1; cat; }`
// hands cat 1142 lines on one run and could hand it none on another. What a
// later reader would find there is refused rather than guessed; what is
// exact — a redirected file put back where the reader stopped, a reader that
// takes no more than it needs, one that read to the end — is answered, and
// were checked against GNU coreutils 9.4, sed 4.9, grep 3.11, gawk 5.2,
// util-linux hexdump, xxd, ripgrep 14.1 and tar 1.35.

const seq = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${from + i}\n`).join('')
const FILES = { five: seq(1, 5), big: seq(1, 3000), left: 'a\nb', h: 'hello\n' }
const terminal = () => createTerminal(FILES, { mount: '/repo', writable: '/tmp/' })

async function answers(command, stdout, exitCode = 0) {
  const r = await terminal().run(command)
  assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, '', exitCode, []], command)
}

// The later reader is refused, naming the one that stopped; what came before
// it stands.
async function refused(command, reader, earlier, stdout = '') {
  const r = await terminal().run(command)
  const message = `${reader}: reading standard input after ${earlier} stopped part way through it is not supported: ${earlier} reads ahead of where it stops, and how far is not known`
  assert.equal(r.stdout, stdout, command)
  assert.notEqual(r.exitCode, 0, command)
  assert.ok(r.stderr.includes(message), `${command}: ${r.stderr}`)
  assert.deepEqual(r.unsupported.map((gap) => [gap.kind, gap.command, gap.detail]), [['feature', reader, 'input after an early stop']], command)
}

describe('a reader that stopped part way through a pipe leaves the rest uncertain', () => {
  for (const [command, earlier, stdout] of [
    ['seq 1 5 | { head -1; cat; }', 'head', '1\n'],
    ['seq 1 5 | { head -n 2; cat; }', 'head', '1\n2\n'],
    ['seq 1 5 | { sed q; cat; }', 'sed', '1\n'],
    ['seq 1 5 | { sed -n 2q; cat; }', 'sed', ''],
    ['seq 1 5 | { sed 2Q; cat; }', 'sed', '1\n'],
    ["seq 1 5 | { awk 'NR==1{print;exit}'; cat; }", 'awk', '1\n'],
    ["seq 1 5 | { awk '{print; nextfile}'; cat; }", 'awk', '1\n'],
    ["seq 1 5 | { awk 'BEGIN{getline; print; exit}'; cat; }", 'awk', '1\n'],
    ['seq 1 5 | { grep -m1 .; cat; }', 'grep', '1\n'],
    ['seq 1 5 | { grep -c -m1 1; cat; }', 'grep', '1\n'],
    ['seq 1 5 | { grep -m1 -A1 1; cat; }', 'grep', '1\n2\n'],
    ['seq 1 5 | { grep -q 1; cat; }', 'grep', ''],
    ['seq 1 5 | { grep -l 1; cat; }', 'grep', '(standard input)\n'],
    ['seq 1 5 | { grep -L 1; cat; }', 'grep', ''],
    ['seq 1 5 | { egrep -m1 .; cat; }', 'egrep', '1\n'],
    ['seq 1 5 | { rg -q 1; cat; }', 'rg', ''],
    ['seq 1 5 | { rg -l 1; cat; }', 'rg', '<stdin>\n'],
    ['seq 1 5 | { xxd -l 2; cat; }', 'xxd', '00000000: 310a                                     1.\n'],
    ['seq 1 5 | { hexdump -n 2; cat; }', 'hexdump', '0000000 0a31                                   \n0000002\n'],
  ]) {
    it(command, () => refused(command, 'cat', earlier, stdout))
  }

  it('refuses whichever reader comes next, however it reaches the input', async () => {
    for (const [command, reader] of [
      ['seq 1 5 | { head -1; tail -n 1; }', 'tail'],
      ['seq 1 5 | { head -1; head -c 1; }', 'head'],
      ['seq 1 5 | { head -1; sed q; }', 'sed'],
      ['seq 1 5 | { head -1; awk 1; }', 'awk'],
      ['seq 1 5 | { head -1; grep .; }', 'grep'],
      ['seq 1 5 | { head -1; wc -l; }', 'wc'],
      ['seq 1 5 | { head -1; od -N 1; }', 'od'],
      ['seq 1 5 | { head -1; xargs echo; }', 'xargs'],
      ['seq 1 5 | { head -1; tar tf -; }', 'tar'],
      ['seq 1 5 | { head -1; cat -; }', 'cat'],
      ['seq 1 5 | { head -1; cat /dev/stdin; }', 'cat'],
      ['seq 1 5 | { head -1; cat < /dev/stdin; }', 'cat'],
      ['seq 1 5 | { head -1; cat | wc -l; }', 'cat'],
      ['seq 1 5 | { head -1; ( cat ); }', 'cat'],
      ['seq 1 5 | ( head -1; cat )', 'cat'],
      ['seq 1 5 | { head -1; { cat; }; }', 'cat'],
      ['seq 1 5 | { head -1 && cat; }', 'cat'],
      ['seq 1 5 | { head -1; if true; then cat; fi; }', 'cat'],
      ['seq 1 5 | { head -1; for i in 1; do cat; done; }', 'cat'],
      ['seq 1 5 | { head -1; echo between; cat; }', 'cat'],
      ['f() { cat; }; seq 1 5 | { head -1; f; }', 'cat'],
      ['f() { head -1; }; seq 1 5 | { f; cat; }', 'cat'],
    ]) {
      const r = await terminal().run(command)
      assert.deepEqual(r.unsupported.map((gap) => [gap.command, gap.detail]), [[reader, 'input after an early stop']], command)
      // A pipeline's status is its last stage's.
      if (!command.includes('| wc')) assert.notEqual(r.exitCode, 0, command)
    }
    // A substitution reads the input the group shares too; echo, whose
    // argument it was, still succeeds, as it does in bash.
    const r = await terminal().run('seq 1 5 | { head -1; echo "[$(cat)]"; }')
    assert.deepEqual([r.stdout, r.unsupported.map((gap) => [gap.command, gap.detail])], ['1\n[]\n', [['cat', 'input after an early stop']]])
  })

  it('refuses a loop reading on where its last turn stopped', async () => {
    const r = await terminal().run('seq 1 5 | while head -n1; do :; done')
    assert.deepEqual([r.stdout, r.unsupported.map((gap) => gap.detail)], ['1\n', ['input after an early stop']])
  })

  it('refuses a reader opening the pipe again after it stopped part way', async () => {
    for (const command of ['seq 1 5 | head -n1 - -', 'seq 1 5 | grep -m1 . - -', "seq 1 5 | awk '{print; nextfile}' - -",
      'seq 1 5 | awk \'NR==1{getline x < "-"; print x}\'', 'seq 1 5 | awk \'BEGIN{getline x < "/dev/stdin"} {print}\'']) {
      const r = await terminal().run(command)
      assert.equal(r.unsupported.length, 1, command)
      assert.notEqual(r.exitCode, 0, command)
    }
  })

  it('reads here-strings and here-documents as the pipes bash 5.2 makes them', async () => {
    await refused('{ head -1; cat; } <<< "$(seq 1 5)"', 'cat', 'head', '1\n')
    await refused('{ sed q; cat; } <<EOF\na\nb\nEOF', 'cat', 'sed', 'a\n')
    await answers('{ head -c 2; cat; } <<< "$(seq 1 5)"', seq(1, 5))
  })
})

describe('other readers that give up part way', () => {
  it('a pipeline whose later stage stops reading ends the stage writing to it', async () => {
    // `seq 1 100000 | { cat | head -1; cat; } | wc -l` counts 76305 lines on
    // one run of GNU's: cat had read what it had when head's exit ended it.
    const r = await terminal().run('seq 1 5 | { cat | head -1; cat; }')
    assert.equal(r.stdout, '1\n')
    assert.match(r.stderr, /^cat: reading standard input after cat stopped part way through it is not supported: a later stage of its pipeline stopped reading what cat wrote/u)
    assert.deepEqual(r.unsupported.map((gap) => gap.detail), ['input after an early stop'])
    for (const command of ['seq 1 5 | { grep 1 | head -c 1; wc -l; }', 'seq 1 5 | { cat | true; cat; }']) {
      assert.deepEqual((await terminal().run(command)).unsupported.map((gap) => gap.detail), ['input after an early stop'], command)
    }
    // A later stage that reads all it is given ends nothing early.
    await answers('seq 1 5 | { cat | cat >/dev/null; cat; }', '')
    await answers('seq 1 5 | { cat | head -1; }', '1\n')
  })

  it('base64 -d gives up at what is not its alphabet, past its first block', async () => {
    const r = await terminal().run("{ printf '!!!!\\n'; seq 1 2000; } | { base64 -d; cat; }")
    assert.deepEqual([r.stdout, r.unsupported.map((gap) => [gap.command, gap.detail])], ['', [['cat', 'input after an early stop']]])
    await answers("printf '!!!!\\nabc\\n' | { base64 -d 2>/dev/null; echo $?; cat; }", '1\n')
  })

  it('xargs gives up at a command exiting 255, leaving what it had not read', async () => {
    const t = createTerminal(FILES, { mount: '/repo', commands: { die: { run: () => ({ exitCode: 255 }) } } })
    const r = await t.run('seq 1 5 | { xargs -n 1 die; cat; }')
    assert.deepEqual(r.unsupported.map((gap) => [gap.command, gap.detail]), [['cat', 'input after an early stop']])
    // Five items in one batch: it read them all before the command gave up.
    assert.deepEqual((await t.run('seq 1 5 | { xargs die; cat; }')).unsupported, [])
  })
})

describe('nothing is refused where nothing reads the uncertain rest', () => {
  for (const [command, stdout] of [
    ['seq 1 5 | { head -1; }', '1\n'],
    ['seq 1 5 | { head -1; echo done; }', '1\ndone\n'],
    ['seq 1 5 | { head -1; cat h; }', '1\nhello\n'],
    ['seq 1 5 | { head -1; cat < h; }', '1\nhello\n'],
    ['seq 1 5 | { head -1; cat <<< hi; }', '1\nhi\n'],
    ['seq 1 5 | { head -1; echo x | cat; }', '1\nx\n'],
    ["seq 1 5 | { head -1; awk 'BEGIN{print 7}'; }", '1\n7\n'],
    // Opened and not read: head -n 0, xxd -l 0, od -N 0, grep -m 0, tail -n 0.
    ['seq 1 5 | { head -1; head -n 0; echo $?; }', '1\n0\n'],
    ['seq 1 5 | { head -1; head -c 0; echo $?; }', '1\n0\n'],
    ['seq 1 5 | { head -1; xxd -l 0; echo $?; }', '1\n0\n'],
    ['seq 1 5 | { head -1; od -N 0; echo $?; }', '1\n0000000\n0\n'],
    ['seq 1 5 | { head -1; grep -m0 x; echo $?; }', '1\n1\n'],
    ['seq 1 5 | { head -1; tail -n 0; echo $?; }', '1\n0\n'],
    // A reader's own records, one at a time, are no stop of anyone else's.
    ["seq 1 5 | sed -n '2p;3q'", '2\n'],
    ["seq 1 5 | awk 'NR==2{print} NR==3{exit}'", '2\n'],
    // Other inputs entirely.
    ['seq 1 5 | { head -1; } ; echo next | cat', '1\nnext\n'],
    ['{ seq 1 5 | head -1; cat; } < h', '1\nhello\n'],
  ]) {
    it(command, () => answers(command, stdout))
  }

  it('keeps the input uncertain past a command that did not read it', async () => {
    await refused('seq 1 5 | { head -1; head -n 0; cat; }', 'cat', 'head', '1\n')
    await refused('seq 1 5 | { head -1; xxd -l 0; cat; }', 'cat', 'head', '1\n')
  })
})

describe('what is exact is answered', () => {
  it('head -c and od -N read a pipe no further than they need', async () => {
    await answers('seq 1 5 | { head -c 2; cat; }', seq(1, 5))
    await answers('seq 1 5 | { head -c 2; head -c 2; cat; }', seq(1, 5))
    await answers('seq 1 5 | head -c2 - -', '==> standard input <==\n1\n\n==> standard input <==\n2\n')
    await answers('seq 1 3000 | { head -c 100 >/dev/null; cat; } | wc -c', '13793\n')
    await answers('seq 1 5 | { od -N 2; cat; }', '0000000 005061\n0000002\n2\n3\n4\n5\n')
    await answers('seq 1 5 | { od -j 2 -N 2; cat; }', '0000002 005062\n0000004\n3\n4\n5\n')
  })

  it('a reader that read to the end leaves nothing to argue about', async () => {
    for (const command of ['seq 1 5 | { head -n 9 >/dev/null; cat; }', 'seq 1 5 | { head -n -2 >/dev/null; cat; }',
      'seq 1 5 | { sed -n 5q; cat; }', 'seq 1 5 | { sed -n 6q; cat; }', 'seq 1 5 | { grep -m1 5 >/dev/null; cat; }',
      'seq 1 5 | { grep -q 5; cat; }', 'seq 1 5 | { grep -q 9; cat; }', "seq 1 5 | { awk 'NR==5{exit}'; cat; }",
      'seq 1 5 | { xxd -l 10 >/dev/null; cat; }', 'seq 1 5 | { grep 1 >/dev/null; cat; }', 'seq 1 5 | { rg -c 1 >/dev/null; cat; }',
      'seq 1 5 | { cat >/dev/null; cat; }']) {
      await answers(command, '')
    }
  })

  it('a redirected file is put back where GNU puts it', async () => {
    await answers('{ head -1; cat; } < five', seq(1, 5))
    await answers('{ head -n 2 >/dev/null; cat; } < big | wc -l', '2998\n')
    await answers('{ head -n -2; echo =; cat; } < five', '1\n2\n3\n=\n4\n5\n')
    await answers('{ head -c -2; echo =; cat; } < five', '1\n2\n3\n4\n=\n5\n')
    await answers('head -n1 - - < five', '==> standard input <==\n1\n\n==> standard input <==\n2\n')
    await answers('{ sed q; cat; } < five', seq(1, 5))
    await answers('{ sed -n q; cat; } < left', 'b')
    await answers('{ grep -m1 .; cat; } < five', seq(1, 5))
    await answers('{ grep -v -m1 1; cat; } < five', seq(2, 5))
    await answers('{ grep -m1 -A1 1; cat; } < five', '1\n2\n2\n3\n4\n5\n')
    await answers('{ grep -m2 1 >/dev/null; cat; } < big | wc -l', '0\n')
    await answers('{ grep -m1 1 >/dev/null; cat; } < big | wc -l', '2999\n')
    await answers('{ hexdump -n 2; cat; } < five', '0000000 0a31                                   \n0000002\n2\n3\n4\n5\n')
    await answers('{ od -N 2; cat; } < five', '0000000 005061\n0000002\n2\n3\n4\n5\n')
  })

  it('a reader that reads a file a block at a time takes a small one whole', async () => {
    // gawk and xxd read 4 KiB, GNU grep -q, -l and -L 96 KiB, and none of
    // them puts the file's offset back.
    for (const [command, stdout] of [
      ["{ awk 'NR==1{print;exit}'; cat; } < five", '1\n'],
      ["{ awk '{print; nextfile}'; cat; } < five", '1\n'],
      ['{ xxd -l 2; cat; } < five', '00000000: 310a                                     1.\n'],
      ['{ grep -q 1; cat; } < five', ''],
      ['{ grep -l 1; cat; } < five', '(standard input)\n'],
      ['{ grep -q 1; cat; } < big', ''],
      ['{ head -1; awk 1 /dev/stdin; } < five', seq(1, 5)],
      ["{ head -1; awk 'BEGIN{while ((getline x < \"-\") > 0) print \"x=\" x}'; } < five", '1\nx=2\nx=3\nx=4\nx=5\n'],
    ]) {
      await answers(command, stdout)
    }
    await refused("{ awk 'NR==1{print;exit}' >/dev/null; cat; } < big", 'cat', 'awk')
    await refused('{ xxd -l 2 >/dev/null; cat; } < big', 'cat', 'xxd')
  })

  it('tar takes an archive on stdin a record at a time, up to its end', async () => {
    const t = terminal()
    const owner = '--owner=user:1000 --group=user:1000'
    await t.run(`tar ${owner} -cf /tmp/h.tar h; tar ${owner} -b 1 -cf /tmp/b1.tar h`)
    assert.deepEqual(await t.run('cat /tmp/h.tar five | { tar tf -; cat; }'), { stdout: 'h\n' + seq(1, 5), stderr: '', exitCode: 0, cwd: '/repo', notes: [], unsupported: [] })
    assert.equal((await t.run('cat /tmp/h.tar five | { tar xOf -; cat; }')).stdout, 'hello\n' + seq(1, 5))
    // An archive shorter than a record: GNU reads a whole one all the same.
    assert.equal((await t.run('cat /tmp/b1.tar big | { tar tf -; cat; } | wc -c')).stdout, `${2048 + FILES.big.length - 10_240 + 2}\n`)
    assert.equal((await t.run('cat /tmp/b1.tar big | { tar -b 1 -tf -; cat; } | wc -c')).stdout, `${FILES.big.length + 2}\n`)
    assert.equal((await t.run('{ tar tf -; cat; } < /tmp/h.tar')).stdout, 'h\n')
  })
})
