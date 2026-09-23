import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { deflateRawSync } from 'node:zlib'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// zip and unzip read and write through @preventive/archive, and say what
// Info-ZIP Zip 3.0 and UnZip 6.00 say (Debian's build of UnZip, which dates
// its listings year first): every expectation below was recorded from them
// in the C.UTF-8 locale, with TZ=UTC, over the same bytes. `pkg.zip` is
// Info-ZIP's `zip -ry` of a small package — directories, files, a link, an
// empty directory, one file big enough to deflate — every entry dated
// 2024-05-06 07:08:09 UTC; `nout.zip` is `zip -X`, whose entries carry the
// DOS time alone.
const bytesOf = (base64) => Uint8Array.from(Buffer.from(base64.replace(/\s/gu, ''), 'base64'))
const PKG_ZIP = bytesOf(`
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
iQMAABYGAAAAAA==`)
const NOUT_ZIP = bytesOf(`
UEsDBAoAAAAAAAU5plgcae8UBgAAAAYAAAANAAAAcGtnL1JFQURNRS5tZCMgcGtnClBLAwQKAAAAAAAFOaZYTkU8KxMAAAATAAAA
EAAAAHBrZy9zcmMvaW5kZXguanNleHBvcnQgY29uc3QgeCA9IDEKUEsBAh4DCgAAAAAABTmmWBxp7xQGAAAABgAAAA0AAAAAAAAA
AQAAAKSBAAAAAHBrZy9SRUFETUUubWRQSwECHgMKAAAAAAAFOaZYTkU8KxMAAAATAAAAEAAAAAAAAAABAAAApIExAAAAcGtnL3Ny
Yy9pbmRleC5qc1BLBQYAAAAAAgACAHkAAAByAAAAAAA=`)
// Python's zipfile, which stores `./a` as it is given one.
const DOT_ZIP = bytesOf('UEsDBBQAAAAAAAU5plgHoerdAgAAAAIAAAADAAAALi9hYQpQSwECFAMUAAAAAAAFOaZYB6Hq3QIAAAACAAAAAwAAAAAAAAAAAAAApIEAAAAALi9hUEsFBgAAAAABAAEAMQAAACMAAAAAAA==')
const NUMBERS = Array.from({ length: 400 }, (_, i) => `${i + 1}\n`).join('')
const SOURCES = {
  'pkg.zip': PKG_ZIP,
  'nout.zip': NOUT_ZIP,
  'dot.zip': DOT_ZIP,
  'empty.zip': Uint8Array.of(0x50, 0x4b, 0x05, 0x06, ...new Uint8Array(18)),
  'notes.txt': 'plain text\n',
  'pkg/README.md': '# pkg\n',
  'pkg/src/index.js': 'export const x = 1\n',
  'pkg/src/lib/util.js': 'export const twice = (n) => n * 2\n',
  'pkg/src/lib/numbers.txt': NUMBERS,
  'pkg/bin/run.sh': '#!/bin/sh\necho run\n',
  'pkg/link': { type: 'link', target: 'README.md' },
}

// A listing prints a time, which is local time unless TZ says UTC.
async function terminal() {
  const t = createTerminal(SOURCES, { mount: '/repo', writable: '/tmp/' })
  await t.run('export TZ=UTC')
  return t
}
const result = (stdout = '', { stderr = '', exitCode = 0, cwd = '/repo', notes = [], unsupported = [] } = {}) =>
  ({ stdout, stderr, exitCode, cwd, notes, unsupported })

async function gap(t, command, detail, stderr) {
  const r = await t.run(command)
  assert.deepEqual(r.unsupported.map((u) => u.detail), [detail], command)
  assert.equal(r.stderr, stderr, command)
  assert.notEqual(r.exitCode, 0, command)
  return r
}

const HEAD = '  Length      Date    Time    Name\n---------  ---------- -----   ----\n'
const ROWS = [
  '        0  2024-05-06 07:08   pkg/',
  '        0  2024-05-06 07:08   pkg/src/',
  '       19  2024-05-06 07:08   pkg/src/index.js',
  '        0  2024-05-06 07:08   pkg/src/lib/',
  '       34  2024-05-06 07:08   pkg/src/lib/util.js',
  '     1492  2024-05-06 07:08   pkg/src/lib/numbers.txt',
  '        6  2024-05-06 07:08   pkg/README.md',
  '        0  2024-05-06 07:08   pkg/empty/',
  '        9  2024-05-06 07:08   pkg/link',
  '        0  2024-05-06 07:08   pkg/bin/',
  '       19  2024-05-06 07:08   pkg/bin/run.sh',
]
const lines = (...picked) => picked.map((line) => line + '\n').join('')
const NO_DIRECTORY = '  End-of-central-directory signature not found.  Either this file is not\n'
  + '  a zipfile, or it constitutes one disk of a multi-part archive.  In the\n'
  + '  latter case the central directory and zipfile comment will be found on\n'
  + '  the last disk(s) of this archive.\n'

describe('unzip lists and tests what an archive holds', () => {
  it('lists every entry as the archive orders them', async () => {
    const t = await terminal()
    const all = `Archive:  pkg.zip\n${HEAD}${lines(...ROWS)}---------                     -------\n     1579                     11 files\n`
    assert.deepEqual(await t.run('unzip -l pkg.zip'), result(all))
    // A name without the suffix is tried with it.
    assert.deepEqual(await t.run('unzip -l pkg'), result(all))
    assert.deepEqual(await t.run("unzip -ql pkg.zip 'pkg/src/*'"), result(`${HEAD}${lines(...ROWS.slice(1, 6))}---------                     -------\n     1545                     5 files\n`))
    assert.deepEqual(await t.run("unzip -qql pkg.zip 'pkg/[!s]*'"), result(lines(...ROWS.slice(6))))
    // -l says nothing of a pattern that matched nothing, and fails only
    // where nothing was listed.
    assert.deepEqual(await t.run('unzip -l pkg.zip nomatch'), result(`Archive:  pkg.zip\n${HEAD}---------                     -------\n        0                     0 files\n`, { exitCode: 11 }))
    assert.deepEqual(await t.run('unzip -l pkg.zip nomatch pkg/README.md'), result(`Archive:  pkg.zip\n${HEAD}${lines(ROWS[6])}---------                     -------\n        6                     1 file\n`))
    // An entry with nothing but a DOS time lists it as it stands.
    assert.deepEqual(await t.run('unzip -l nout.zip'), result(`Archive:  nout.zip\n${HEAD}${lines(ROWS[6], ROWS[2])}---------                     -------\n       25                     2 files\n`))
  })

  it('refuses to list times it cannot tell the reading of', async () => {
    // The package says what an entry's time is, not whether it was an
    // exact one, which UnZip prints in local time, or a DOS one, which it
    // prints as it stands: outside UTC the two differ.
    const previous = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const t = createTerminal(SOURCES, { mount: '/repo', writable: '/tmp/' })
      await gap(t, 'unzip -l pkg.zip', 'archive times', "unzip: whether an entry's time is exact or a DOS time is not known here, and outside UTC the two are listed differently (TZ=UTC answers it)\n")
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })

  it('tests every entry, and says of those it did not find', async () => {
    const t = await terminal()
    const test = (name) => `    testing: ${name.padEnd(22)}   OK\n`
    const names = ['pkg/', 'pkg/src/', 'pkg/src/index.js', 'pkg/src/lib/', 'pkg/src/lib/util.js', 'pkg/src/lib/numbers.txt', 'pkg/README.md', 'pkg/empty/', 'pkg/link', 'pkg/bin/', 'pkg/bin/run.sh']
    assert.deepEqual(await t.run('unzip -t pkg.zip'), result(`Archive:  pkg.zip\n${names.map(test).join('')}No errors detected in compressed data of pkg.zip.\n`))
    assert.deepEqual(await t.run('unzip -tq pkg.zip'), result('No errors detected in compressed data of pkg.zip.\n'))
    assert.deepEqual(await t.run('unzip -tqq pkg.zip'), result(''))
    // Everything -t says goes to stdout, a pattern it did not find included.
    assert.deepEqual(await t.run('unzip -t pkg.zip nomatch pkg/README.md'), result(`Archive:  pkg.zip\n${test('pkg/README.md')}caution: filename not matched:  nomatch\nAt least one error was detected in pkg.zip.\n`, { exitCode: 11 }))
    assert.deepEqual(await t.run("unzip -t pkg.zip -x 'pkg/src/*' nothere"), result(
      `Archive:  pkg.zip\n${[names[0], ...names.slice(6)].map(test).join('')}caution: excluded filename not matched:  nothere\nNo errors detected in pkg.zip for the 6 files tested.\n`,
    ))
    assert.deepEqual(await t.run('unzip -tq pkg.zip pkg/link'), result('No errors detected in pkg.zip for the 1 file tested.\n'))
  })

  it('pipes the members out as they are stored', async () => {
    const t = await terminal()
    // In the archive's order, a link as the path it holds.
    assert.deepEqual(await t.run('unzip -p pkg.zip pkg/link pkg/README.md'), result('# pkg\nREADME.md'))
    assert.deepEqual(await t.run('unzip -p pkg.zip nomatch'), result('', { stderr: 'caution: filename not matched:  nomatch\n', exitCode: 11 }))
    assert.deepEqual(await t.run("unzip -p pkg.zip 'pkg/src/lib/*.js' pkg/bin/run.sh -x nothere"), result('export const twice = (n) => n * 2\n#!/bin/sh\necho run\n', { stderr: 'caution: excluded filename not matched:  nothere\n' }))
  })

  it('says what UnZip says of what is not an archive', async () => {
    const t = await terminal()
    const period = 'unzip:  cannot find zipfile directory in one of notes.txt or\n        notes.txt.zip, and cannot find notes.txt.ZIP, period.\n'
    assert.deepEqual(await t.run('unzip missing'), result('', { stderr: 'unzip:  cannot find or open missing, missing.zip or missing.ZIP.\n', exitCode: 9 }))
    assert.deepEqual(await t.run('unzip notes.txt'), result('Archive:  notes.txt\n', { stderr: NO_DIRECTORY + period, exitCode: 9 }))
    assert.deepEqual(await t.run('unzip -p notes.txt'), result('', { stderr: '[notes.txt]\n' + NO_DIRECTORY, exitCode: 9 }))
    assert.deepEqual(await t.run('unzip -q notes.txt'), result('', { stderr: '[notes.txt]\n' + NO_DIRECTORY + period, exitCode: 9 }))
    assert.deepEqual(await t.run('unzip -t notes.txt'), result('Archive:  notes.txt\n' + NO_DIRECTORY + period, { exitCode: 9 }))
    assert.deepEqual(await t.run('unzip empty.zip'), result('Archive:  empty.zip\n', { stderr: 'warning [empty.zip]:  zipfile is empty\n', exitCode: 1 }))
    assert.deepEqual(await t.run('unzip -p empty.zip'), result('', { stderr: 'warning [empty.zip]:  zipfile is empty\n', exitCode: 1 }))
  })

  it('refuses an archive whose names it cannot give back as stored', async () => {
    // UnZip lists and matches `./a` as it is stored; the package hands it out
    // as `a`. Nothing is extracted, and no -d directory made.
    const t = await terminal()
    const dot = "unzip: ./a: names stored with `.' segments are not supported\n"
    await gap(t, 'unzip -l dot.zip', 'dot-segment names', dot)
    await gap(t, 'unzip -p dot.zip ./a', 'dot-segment names', dot)
    await gap(t, 'unzip -q dot.zip -d /tmp/out', 'dot-segment names', dot)
    assert.equal((await t.run('ls -A /tmp')).stdout, '')
  })
})

describe('unzip extracts into the writable overlay', () => {
  const tree = 'out\nout/pkg\nout/pkg/README.md\nout/pkg/bin\nout/pkg/bin/run.sh\nout/pkg/empty\nout/pkg/link\nout/pkg/src\nout/pkg/src/index.js\nout/pkg/src/lib\nout/pkg/src/lib/numbers.txt\nout/pkg/src/lib/util.js\n'
  const replace = (name) => `replace ${name}? [y]es, [n]o, [A]ll, [N]one, [r]ename:  NULL\n(EOF or read error, treating as "[N]one" ...)\n`

  it('writes quietly what the archive holds', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('cd /tmp && unzip -q /repo/pkg.zip -d out && find out | sort && cat out/pkg/link'), result(`${tree}# pkg\n`, { cwd: '/tmp' }))
    // A name already there is asked about, on a stdin with nothing on it —
    // "None" from then on.
    assert.deepEqual(await t.run('unzip -q /repo/pkg.zip -d out'), result('', { stderr: replace('out/pkg/src/index.js'), exitCode: 1, cwd: '/tmp' }))
    assert.deepEqual(await t.run('unzip -qo /repo/pkg.zip -d out'), result('', { cwd: '/tmp' }))
    assert.deepEqual(await t.run('unzip -qn /repo/pkg.zip -d out'), result('', { cwd: '/tmp' }))
    assert.deepEqual(await t.run('unzip -qq /repo/pkg.zip pkg/README.md -d out'), result('', { stderr: replace('out/pkg/README.md'), exitCode: 1, cwd: '/tmp' }))
  })

  it('junks paths, excludes, and reports what it did not find', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('cd /tmp && unzip -qj /repo/pkg.zip -d j && find j | sort'), result('j\nj/README.md\nj/index.js\nj/link\nj/numbers.txt\nj/run.sh\nj/util.js\n', { cwd: '/tmp' }))
    assert.deepEqual(await t.run("unzip -q /repo/pkg.zip -x 'pkg/src/*' -d x && find x | sort"), result('x\nx/pkg\nx/pkg/README.md\nx/pkg/bin\nx/pkg/bin/run.sh\nx/pkg/empty\nx/pkg/link\n', { cwd: '/tmp' }))
    assert.deepEqual(await t.run('unzip -q /repo/pkg.zip nomatch pkg/README.md -d y'), result('', { stderr: 'caution: filename not matched:  nomatch\n', exitCode: 11, cwd: '/tmp' }))
  })

  it('makes the -d directory, and no more than it', async () => {
    const t = await terminal()
    const missing = result('', { stderr: 'error:  must specify directory to which to extract with -d option\n', exitCode: 10 })
    assert.deepEqual(await t.run('unzip -d'), missing)
    assert.deepEqual(await t.run('unzip pkg.zip -d'), missing)
    assert.deepEqual(await t.run('unzip -p pkg.zip pkg/README.md -dx'), result('# pkg\n', { stderr: 'caution:  not extracting; -d ignored\n' }))
    assert.deepEqual(await t.run('cd /tmp && unzip -d nodir/deeper /repo/pkg.zip'), result('Archive:  /repo/pkg.zip\n', {
      stderr: 'checkdir:  cannot create extraction directory: nodir/deeper\n           No such file or directory\n', exitCode: 2, cwd: '/tmp',
    }))
    // A directory is "creating" whatever it is.
    assert.deepEqual(await t.run("unzip /repo/pkg.zip 'pkg/*/' -d dirs"), result('Archive:  /repo/pkg.zip\n   creating: dirs/pkg/src/\n   creating: dirs/pkg/src/lib/\n   creating: dirs/pkg/empty/\n   creating: dirs/pkg/bin/\n', { cwd: '/tmp' }))
  })

  it('reports what it cannot say or write as a gap', async () => {
    const t = await terminal()
    // Each file is "extracting" or "inflating" by how it was stored, which
    // the package does not say; -q says neither.
    const listing = 'unzip: whether each file was stored or deflated is not known here, and an extraction that is not quiet names it (-q extracts without it)\n'
    const r = await gap(t, 'cd /tmp && unzip /repo/pkg.zip -d out', 'extraction listing', listing)
    assert.equal(r.stdout, 'Archive:  /repo/pkg.zip\n   creating: out/pkg/\n   creating: out/pkg/src/\n')
    await gap(t, 'unzip -v /repo/pkg.zip', '-v', 'unzip: how each entry is stored is not known here, which this listing prints\n')
    await gap(t, 'cd /repo && unzip -q pkg.zip', 'read-only target', 'unzip: pkg/: Read-only file system\n')
  })
})

// What the runtime's deflate saves on a file, rounded as Info-ZIP rounds it.
function deflated(text) {
  const n = Buffer.byteLength(text)
  const m = deflateRawSync(text).length
  return Math.floor((1 + Math.floor((200 * (n - m)) / n)) / 2)
}

describe('zip writes an archive UnZip reads back', () => {
  it('adds each entry and says how it was stored', async () => {
    const t = await terminal()
    const added = (name, how = 'stored 0') => `  adding: ${name} (${how}%)\n`
    assert.deepEqual(await t.run('zip -r /tmp/a.zip pkg'), result([
      added('pkg/'), added('pkg/README.md'), added('pkg/bin/'), added('pkg/bin/run.sh'), added('pkg/link'), added('pkg/src/'),
      added('pkg/src/index.js'), added('pkg/src/lib/'), added('pkg/src/lib/numbers.txt', `deflated ${deflated(NUMBERS)}`), added('pkg/src/lib/util.js'),
    ].join('')))
    assert.deepEqual(await t.run('unzip -tq /tmp/a.zip && unzip -p /tmp/a.zip pkg/link'), result('No errors detected in compressed data of /tmp/a.zip.\n# pkg\n'))
  })

  it('says what Info-ZIP says, where Info-ZIP says it', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('zip /tmp/b pkg/README.md missing pkg/src'), result('\tzip warning: name not matched: missing\n  adding: pkg/README.md (stored 0%)\n  adding: pkg/src/ (stored 0%)\n'))
    assert.deepEqual(await t.run('zip -q /tmp/c.zip pkg/README.md; echo $?'), result('0\n'))
    assert.deepEqual(await t.run('zip /tmp/d.zip missing'), result('\tzip warning: name not matched: missing\n\nzip error: Nothing to do! (/tmp/d.zip)\n', { exitCode: 12 }))
    assert.deepEqual(await t.run('zip /tmp/nodir/e.zip pkg/README.md'), result('zip I/O error: No such file or directory\nzip error: Could not create output file (/tmp/nodir/e.zip)\n', { exitCode: 15 }))
    assert.deepEqual(await t.run('zip -ry /tmp/f.zip pkg/link pkg/README.md && unzip -p /tmp/f.zip pkg/link'), result('  adding: pkg/link (stored 0%)\n  adding: pkg/README.md (stored 0%)\nREADME.md'))
    assert.deepEqual(await t.run('zip -rj /tmp/g.zip pkg/bin pkg/src/index.js'), result('  adding: run.sh (stored 0%)\n  adding: index.js (stored 0%)\n'))
    assert.deepEqual(await t.run('zip -rD /tmp/h.zip pkg/bin'), result('  adding: pkg/bin/run.sh (stored 0%)\n'))
    assert.deepEqual(await t.run('zip -0 /tmp/i.zip pkg/src/lib/numbers.txt'), result('  adding: pkg/src/lib/numbers.txt (stored 0%)\n'))
    assert.deepEqual(await t.run('zip /tmp/j.zip pkg'), result('  adding: pkg/ (stored 0%)\n'))
  })

  it('takes one file named twice once, and refuses two names for one entry', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('zip /tmp/r.zip pkg/README.md pkg/README.md'), result('  adding: pkg/README.md (stored 0%)\n'))
    assert.deepEqual(await t.run('zip /tmp/q.zip pkg/README.md ./pkg/README.md'), result(
      '\tzip warning:   first full name: ./pkg/README.md\n                      second full name: pkg/README.md\n                     name in zip file repeated: pkg/README.md\n\nzip error: Invalid command arguments (cannot repeat names in zip file)\n',
      { exitCode: 16 },
    ))
    assert.deepEqual(await t.run('cd pkg && zip -r /tmp/k.zip ./bin .'), result(
      '\tzip warning:   first full name: ./bin/\n                      second full name: bin/\n                     name in zip file repeated: bin/\n\nzip error: Invalid command arguments (cannot repeat names in zip file)\n',
      { exitCode: 16, cwd: '/repo/pkg' },
    ))
  })

  it('reports what it cannot write as it stands as a gap', async () => {
    const t = await terminal()
    await gap(t, 'zip /tmp/a.zip pkg/README.md && zip /tmp/a.zip pkg/src/index.js', 'existing archive', 'zip: /tmp/a.zip: adding to an archive that is already there is not supported\n')
    await gap(t, 'zip -9 /tmp/l.zip pkg/README.md', '-9', 'zip: unknown option: -9\n')
    // Info-ZIP writes no archive to a terminal, and says so where a filter's
    // messages go; into a file or down a pipe it streams one, which is a gap.
    const terminalOut = result('', { stderr: '\nzip error: Invalid command arguments (cannot write zip file to terminal)\n', exitCode: 16 })
    assert.deepEqual(await t.run('zip - pkg/README.md'), terminalOut)
    assert.deepEqual(await t.run('zip -q'), terminalOut)
    await gap(t, 'zip - pkg/README.md > /tmp/s.zip', 'streamed archive', 'zip: writing an archive to stdout is not supported\n')
    // Info-ZIP stores `../README.md` as it is typed; the package stores no climb.
    await gap(t, 'cd pkg/src && zip /tmp/m.zip ../README.md', 'dot-segment names', "zip: ../README.md: names with `.', `..' or empty segments are not supported\n")
    await gap(t, 'zip /repo/n.zip /repo/pkg/README.md', 'read-only target', 'zip: /repo/n.zip: Read-only file system\n')
  })
})
