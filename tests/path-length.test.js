import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Checked against Linux 6.x with GNU coreutils 9.4 and findutils 4.9: a name
// is copied into the kernel whole, into PATH_MAX bytes that end with its NUL,
// and a directory refuses a component past NAME_MAX bytes when the walk asks
// it about one. A walk that hands over one directory's names at a time is held
// to neither.
const SOURCES = { file: 'plain\n', 'dir/leaf': 'leaf\n' }
const terminal = () => createTerminal(SOURCES, { mount: '/repo', cwd: '/repo', writable: '/tmp/' })
const LONG = 'a'.repeat(256)
const TOO_LONG = 'File name too long'

async function check(t, command, stdout = '', stderr = '', exitCode = 0) {
  assert.deepEqual(await t.run(command), { stdout, stderr, exitCode, cwd: '/repo', notes: [], unsupported: [] }, command)
}

describe('a component longer than NAME_MAX', () => {
  it('is too long wherever a directory is asked about it', async () => {
    const t = terminal()
    await check(t, `cat ${LONG}`, '', `cat: ${LONG}: ${TOO_LONG}\n`, 1)
    await check(t, `ls ${LONG}`, '', `ls: cannot access '${LONG}': ${TOO_LONG}\n`, 2)
    await check(t, `find ${LONG}`, '', `find: ‘${LONG}’: ${TOO_LONG}\n`, 1)
    await check(t, `test -e ${LONG}`, '', '', 1)
    await check(t, `mkdir /tmp/${LONG}`, '', `mkdir: cannot create directory ‘/tmp/${LONG}’: ${TOO_LONG}\n`, 1)
    await check(t, `touch /tmp/${LONG}`, '', `touch: cannot touch '/tmp/${LONG}': ${TOO_LONG}\n`, 1)
    // cp asks after the destination before it opens one.
    await check(t, `cp file /tmp/${LONG}`, '', `cp: cannot stat '/tmp/${LONG}': ${TOO_LONG}\n`, 1)
    // ln names both halves of a link it could not make where either may be why.
    await check(t, `ln -s x /tmp/${LONG}`, '', `ln: failed to create symbolic link '/tmp/${LONG}' -> 'x': ${TOO_LONG}\n`, 1)
    await check(t, 'ls /tmp')
  })

  it('counts bytes, not characters', async () => {
    const t = terminal()
    await check(t, `touch /tmp/${'a'.repeat(255)} && ls /tmp | wc -c`, '256\n')
    await check(t, `cat ${'é'.repeat(128)}`, '', `cat: ${'é'.repeat(128)}: ${TOO_LONG}\n`, 1)
  })

  it('is answered after a missing or non-directory component before it', async () => {
    const t = terminal()
    await check(t, `cat nope/${LONG}`, '', `cat: nope/${LONG}: No such file or directory\n`, 1)
    await check(t, `cat file/${LONG}`, '', `cat: file/${LONG}: Not a directory\n`, 1)
    await check(t, `cat ${LONG}/x`, '', `cat: ${LONG}/x: ${TOO_LONG}\n`, 1)
  })
})

describe('a name of PATH_MAX bytes or more', () => {
  const deep = (count) => '/tmp/' + Array.from({ length: count }, () => 'd'.repeat(200)).join('/')

  it('is too long before anything in it is looked up', async () => {
    const t = terminal()
    const name = deep(21)
    assert.ok(name.length >= 4096)
    await check(t, `cat ${name}`, '', `cat: ${name}: ${TOO_LONG}\n`, 1)
    await check(t, `ln -s ${'t'.repeat(5000)} /tmp/l`, '', `ln: failed to create symbolic link '/tmp/l' -> '${'t'.repeat(5000)}': ${TOO_LONG}\n`, 1)
    await check(t, `ln -s ${'t'.repeat(4095)} /tmp/l && echo made`, 'made\n')
  })

  it('is made by mkdir -p a component at a time, as GNU makes it', async () => {
    const t = terminal()
    const name = deep(25)
    await check(t, `mkdir -p ${name} && find /tmp -type d | wc -l`, '26\n')
    await check(t, `test -d ${name}`, '', '', 1)
  })
})

describe('a walk into a tree its own -exec grows', () => {
  it('stops where the name -exec is handed grows too long, as GNU stops', async () => {
    const t = terminal()
    const r = await t.run('mkdir -p /tmp/d; find /tmp/d -type d -exec mkdir {}/z \\; ; echo "exit=$?"; find /tmp/d | wc -l')
    assert.equal(r.stdout, 'exit=0\n2045\n')
    // The 2045th level would be named by 4096 bytes, one past PATH_MAX.
    assert.equal(r.stderr, `mkdir: cannot create directory ‘/tmp/d${'/z'.repeat(2045)}’: ${TOO_LONG}\n`)
    assert.deepEqual(r.unsupported, [])
  })

  it('is followed for as many directories as one name can be built to', async () => {
    const t = terminal()
    // Two at every level to the eleventh is 4094 new directories walked into,
    // and the 4096 the last level makes past -maxdepth.
    const r = await t.run('mkdir /tmp/d; find /tmp/d -maxdepth 11 -type d -exec mkdir {}/a {}/b \\; ; find /tmp/d | wc -l')
    assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], ['8191\n', '', 0, []])
  })

  it('is refused past that, where GNU goes on for as long as there is disk', async () => {
    const t = terminal()
    const r = await t.run('mkdir /tmp/d; find /tmp/d -maxdepth 12 -type d -exec mkdir {}/a {}/b \\;')
    assert.equal(r.exitCode, 1)
    assert.equal(r.stderr, 'find: a walk into more than 4096 directories its own actions made is not supported\n')
    assert.deepEqual(r.unsupported.map(({ command, detail }) => [command, detail]), [['find', 'self-growing walk']])
  })
})
