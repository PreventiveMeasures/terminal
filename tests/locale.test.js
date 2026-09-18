import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { dot: 'aéb\n', cafe: 'café\n', 'src/a.ts': '' }
const MESSAGE = 'only the C.UTF-8 locale is supported'
const run = (line, opts) => createTerminal(FILES, opts).run(line)
const ok = (stdout, extra = {}) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [], ...extra })

describe('the locale is C.UTF-8', () => {
  it('is what $LANG answers, in a terminal and in its forks', () => {
    assert.deepEqual(run('echo $LANG'), ok('C.UTF-8\n'))
    const t = createTerminal(FILES)
    assert.equal(t.fork().run('echo $LANG').stdout, 'C.UTF-8\n')
    assert.equal(t.fork({ inherit: false, user: 'ada' }).run('echo $LANG').stdout, 'C.UTF-8\n')
  })

  it('is the one value createTerminal takes, spelt as glibc spells it', () => {
    for (const locale of ['C.UTF-8', 'C.utf8', 'c.UTF8']) assert.equal(run('echo $LANG', { locale }).stdout, 'C.UTF-8\n', locale)
    for (const locale of ['C', 'POSIX', 'en_US.UTF-8', '', 7]) {
      assert.throws(() => createTerminal(FILES, { locale }), { name: 'TypeError', message: `createTerminal: ${MESSAGE} (got ${JSON.stringify(locale)})` }, String(locale))
    }
    assert.throws(() => createTerminal(FILES).fork({ locale: 'C.UTF-8' }), /fork: unknown option `locale`/u)
  })

  it('takes an assignment that leaves the character set where it is', () => {
    for (const line of [
      'LANG=C.UTF-8 echo ok', 'LC_ALL=C.utf8 echo ok', 'LC_CTYPE=c.utf8; echo ok', 'LC_ALL= echo ok', 'LC_CTYPE=; echo ok',
      // The other categories read the same in C and POSIX as in C.UTF-8.
      'LC_COLLATE=C sort -u dot >/dev/null; echo ok', 'LC_NUMERIC=POSIX du -bh cafe >/dev/null; echo ok', 'LC_TIME= echo ok', 'export LC_MESSAGES=C; echo ok',
      'unset LC_ALL LC_CTYPE; echo ok',
      // Appending nothing to what $LANG answers leaves it as it was.
      'export LANG+=; echo ok',
    ]) {
      const r = run(line)
      assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], ['ok\n', '', 0, []], line)
    }
    assert.equal(run('LC_ALL=C.utf8; echo $LC_ALL $LANG').stdout, 'C.utf8 C.UTF-8\n')
  })

  it('refuses an assignment that would move it, before the command runs', () => {
    for (const [line, name] of [
      ['LANG=C grep -o f. cafe', 'LANG'], ['LC_ALL=C grep -c a.b dot', 'LC_ALL'], ['LC_CTYPE=POSIX sed s/./x/ cafe', 'LC_CTYPE'],
      ['LANG=en_US.UTF-8 wc -m cafe', 'LANG'], ['LANG= wc -m cafe', 'LANG'], ['LC_COLLATE=en_US.UTF-8 sort dot', 'LC_COLLATE'],
      ['LC_ALL=C wc -wm cafe', 'LC_ALL'], ['LC_ALL=C find . -ipath "*.ts"', 'LC_ALL'], [String.raw`LC_ALL=C awk '{print length}' cafe`, 'LC_ALL'],
      ['LC_ALL=C rm -v cafe', 'LC_ALL'], ['LC_ALL=C realpath -e -- cafe', 'LC_ALL'], ['LC_ALL=C printf "\\u00e9"', 'LC_ALL'],
    ]) {
      const message = `${name}: ${MESSAGE}`
      assert.deepEqual(run(line), ok('', { stderr: `error: ${message}\n`, exitCode: 1, unsupported: [{ kind: 'feature', command: null, detail: name, message }] }), line)
    }
    // `export` appends to what $LANG answers, so the result names no locale.
    for (const [line, name] of [['export LC_ALL=C', 'LC_ALL'], ['export LANG+=C.UTF-8', 'LANG']]) {
      const exported = run(line)
      assert.deepEqual([exported.stdout, exported.exitCode, exported.unsupported.map((u) => [u.command, u.detail])], ['', 1, [['export', name]]], line)
      assert.match(exported.stderr, new RegExp(`${name}: only the C\\.UTF-8 locale is supported`, 'u'), line)
    }
  })

  it('refuses unsetting LANG, which would hand the character set to C', () => {
    const message = `unset: LANG: ${MESSAGE}`
    assert.deepEqual(run('unset LANG'), ok('', { stderr: message + '\n', exitCode: 1, unsupported: [{ kind: 'feature', command: 'unset', detail: 'LANG', message }] }))
    assert.deepEqual(run('unset LC_ALL; echo $LANG'), ok('C.UTF-8\n'))
  })

  it('runs what a refused assignment did not stop in C.UTF-8', () => {
    const r = run('LC_ALL=C; wc -m cafe')
    assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported.map((u) => u.detail)], ['5 cafe\n', `error: LC_ALL: ${MESSAGE}\n`, 0, ['LC_ALL']])
  })
})
