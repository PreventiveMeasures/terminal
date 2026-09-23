import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { gunzipSync } from 'node:zlib'
import { describe, it, mock } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// tar reads and writes through @preventive/archive, and says what GNU tar 1.35
// says: every expectation below was recorded from GNU tar in the C.UTF-8
// locale, with TZ=UTC, over the same bytes. The archives are GNU's own:
// `pkg` is a small package — directories, files, an executable, a link and
// an empty directory — made with `tar --sort=name --owner=dev:1000
// --group=staff:50`, every entry dated 2024-05-06 07:08:09 UTC; `pkg.tgz` is
// the same archive through `gzip -9 -n`; `dot.tar` is the package's contents
// made from `.`; `sp.tar` holds a hard link, a fifo and a character device.
const bytesOf = (base64) => Uint8Array.from(Buffer.from(base64.replace(/\s/gu, ''), 'base64'))
const PKG_TGZ = bytesOf(`
H4sIAAAAAAACA+3XT28cRRDG4T3XpxjEBTiYrrf6z8whSEjkyIVvQJwNXhKvLe8azLfnV87NSEGJtJsonpZaq1hlx36f6prp27d/
/Lg58Sqs0Vp++mjl8d+l6/3n+7Xx2r07deGb4kWjbqa2OcO6Pxx/v5umzevtXx+so+zNm81Xt27x/+3lz7/8+vLi+vUJ/XutH/Dv
T/y91bGZyup/8vXtRAfYZl3PdOX5f7Xbn/QZ8PHz30td5/9Z/e/u9xeHq8/kr3jiLxWt8/8s8/+bR/7DlW0vr24m2mB9GDy3+b+9
vj3+c8InwCfM/xpa5/+5/N/t9m9P/vwf4yP8VaNsJp36YrL6P/of7i6/uPe/Huv5P6f/bv96+3Dx5+Gz3P//+/7X+NL6/neGtX24
vbk7Tpc3+8NxepheTL6+/z239788/+92r072DPiE+d/5WOf/mf3399evtneHi+PD8ZzzX0P1iX8tbb3/n2W5ycKqNes2bLbFvJi7
uczDvJo3824+zGfzxVRMfI9MYaqmZuqmYZpNi0WxcAt+ZFhUi2bRLYbFbLFYLVbdqqzyP1arzWq3OqzOVhdrxZpbk7Wwxi/UrHVr
w9psbbFerLt1WQ/r1Tq/b7c+rM/WFxvFhtuQjbBRbTQb/DnDxmxjsbnY7DbL5rC52txs7jbz1842L7YUW9wW2RK2VFuaLd2WYQth
ZBrEUcijEEghkUIkhUwKoRRSKcRSqHuMjboMLpPL6DK7DC/Ty/jIzwnQlflSR4ZcddjUEaOToxOkk6QTpZOlR0JQR5xOnk6gTqJO
pE6mHBU2dcTKrZlNHclyntjUEa6TrhOvk68TsJOwt6SljpCdlJ2YnZydoDmIbOrI2gnbe/YAdeTtBO4k7kTuZO6E7qTuxM7hZmez
UEf0TvZO+E76TvxO/g6AI+AQ+JxdRR0KDoPj4EA4Eg6FY+FgOBq+ZPtl/9GAeAgP4SE8hIfwEB7CQ3jIs1Gpw0N4CA/hITyEh/BQ
9nM29GNHU5c9nU2dXZ1tnX2djY2H8BAeimx96vAQHsJDeAgP4SE8hIfw4BbLpg4P4SE8hIfwEB7CgzddNnUtDxN1eAgP4SE8hIfw
EB7CQ3io56mjDg/hITyEh/BgmLKpw0N4aOTxpA4P4SE8hIfwEB7CQ3gID815jqnDQ3gID+EhPISH8BAewkNLHvg88Rx5PAKPwCPw
CDwCj8Aj8Ag8wnM0UIdH4BF4BB6BR+AReAQegUcoZwh1eAQegUfgEXgEHpGTJkdNzprHYUNdjpucNzlwcuLkyMEj8Ag8Ao+oOZWo
wyPwCDwCj8Aj8Ag8Ao/AI1qOL+rwCDwCj8Aj8Ag8Ao/AI/CInnOOOjwCj8Aj8Ag8Ao/AI/AIPGLkQKQOj8Aj8Ag8Ao/AI/AIPAKP
mHNyUodH4BF4BB6BR+AReAQegUcsOWJzxhb71Of//XH37hRXwP+9/1U9ef7THWV9/p/9/nf8e3e55Q743f776cVP0376YdJ6HVzX
uta1rq9y/Qs0aEGyACgAAA==`)
const PKG_TAR = new Uint8Array(gunzipSync(PKG_TGZ))
const DOT_TAR = new Uint8Array(gunzipSync(bytesOf(`
H4sIAAAAAAACA+3Xy24kRRCF4V7HUxRiAyzaFSfyUrUYJCRmyYY3wJ4WbsZuW+62MG/PH73DSFxG6hqEK6WSLSt8O19kZOX2anPx
NbJ6reePrNcfz597ad6cunC+np9thrpZYD0fTz89DcPmja7t1Y/vv/v+h/fb+w8X9W+l/IV/e+Xfo8ZmGFf/i68vh8ePP9tmXW92
/1/vDxc+Az5h/re6zv8F/Z+eD9vj7WfzV/zR389Hwjr/l5j/X5wb4Hhru5vbh4FGWA+Dt7X/d/ePp98uegL8+/nfFW2d/8v43+0P
Hxc4/3v/5/7OiVA2gy5/NVn9r45PN//B97/W1/2/nP/+8GH3sv3l+Jnu/39+/wv19f1vibV7eXx4Og03D4fjaXgZ3g2+vv+9vf1/
t7++4BnwCe9/Jeo6/5f1PzzfX++ejtvTy2nZ+a+u8mr+e6vr/X+R5SYLK1atWbfJZvPR3M1lHubFvJo3824+mc+m0cT3yBSmYqqm
ZuqmyTRbjBZuwY8Mi2JRLZpFt5gsZiujFbciK/zGYqVaaVa6lcnKbHW06lZlNazyB1WrzWq3OlmdrY3W3JqshbVijb+3WevWJmuz
9dG6W5f1sF6sV+v8O936ZH22abTJbZJNYVOxqdrUbOK/nWyabR5tdptlc9hcbK42N5u7zYSRaRDHSB4jgYwkMhLJSCYjoYykMhLL
SN05NuoyuEwuo8vsMrxML+MjPydAV+ZLHRk6ITopOjE6OTpBOkk6UTpZeiQEdcTp5OkE6iTqROpk6oTqpOrE6iXFqCNZ9hMPdYTr
pOvE6+TrBOwk7DVpqSNkJ2UnZidnJ2g2Ig91ZO2EzW7koY68ncCdxJ3Incyd0J3Undid3L1ns1BH9E72TvhO+k78Tv4OgCPgEPiU
XUUdCg6D4+BAOBIOhWPhYDgaPmf7Zf/RgHgID+EhPISH8BAewkN4yLNRqcNDeAgP4SE8hIfwUPZzNvS5o6nLns6mzq7Ots6+zsbG
Q3gID0W2PnV4CA/hITyEh/AQHsJDeKjkHqEOD+EhPISH8BAewkN4CA/V3EzU4SE8hIfwEB7CQ3gID+GhlruOOjyEh/AQHsKDYcpD
HR7CQz23J3V4CA/hITyEh/AQHsJDeGjKfUwdHsJDeAgP4SE8hIfwEB6ac8PnjmfL4xF4BB6BR+AReAQegUfgEZ6jgTo8Ao/AI/AI
PAKPwCPwCDxCOUOowyPwCDwCDy4FPNTlpMlRk7PmPGyoy3GT8yYHTk6cHDl4BB6BR+ARJacSdXgEHoFH4BF4BB6BR+AReETN8UUd
HoFH4BF4BB6BR+AReAQe0XLOUYdH4BF4BB6BR+AReAQegUf0HIjU4RF4BB6BR+AReAQegUfgEVNOTurwCDwCj8Aj8Ag8Ao/AI/CI
OUdsztjRPu38fz7t7y5zBfzb+1/R6/tfp3w9/5e+/51+3d/suAN+dfh6ePftcBi+GbReB9e1rnWt63+5fgfvTWWMACgAAA==`)))
const SP_TAR = new Uint8Array(gunzipSync(bytesOf(`
H4sIAAAAAAACA+3VQQ6CMBCF4Vl7it6A1rbDeRqR6EoC6Pmt6IqFcUMD8n+baZpumpeZGbpKlmazOsapZvM6nV1Qpy6/8y7fq9co
JkoB92FMvTGyU0NXnZrzY/H8NYTf83c2qIrxW8r//Q/3qX5D+bcl+v97/nHe/9FbMZb+X1yTxnQQ7Hj+t9f2tq75b+vjsRaj9H+J
/C+pb9a2/18rwbgSy2nn+QMAAAAAAAAAAAD4H09P7romACgAAA==`)))

const SOURCES = {
  'pkg.tar': PKG_TAR,
  'pkg.tgz': PKG_TGZ,
  'dot.tar': DOT_TAR,
  'sp.tar': SP_TAR,
  'notes.txt': 'plain text\n',
  'empty.zip': Uint8Array.of(0x50, 0x4b, 0x05, 0x06, ...new Uint8Array(18)),
  'pkg/README.md': '# pkg\n',
  // xz's first six bytes, which is all GNU looks at.
  'fake.xz': Uint8Array.of(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x6a, 0x75, 0x6e, 0x6b),
  'trailing.tgz': Uint8Array.of(...PKG_TGZ, ...Buffer.from('plain text\n')),
  'cut.tgz': PKG_TGZ.subarray(0, 300),
}

// Every listing prints a time, which is local time unless TZ says UTC.
async function terminal(sources = SOURCES) {
  const t = createTerminal(sources, { mount: '/repo', writable: '/tmp/' })
  await t.run('export TZ=UTC')
  return t
}
const result = (stdout = '', { stderr = '', exitCode = 0, cwd = '/repo', notes = [], unsupported = [] } = {}) =>
  ({ stdout, stderr, exitCode, cwd, notes, unsupported })

// A gap reports on every channel: the command fails, says why, and the run
// carries the diagnostic where a redirect cannot hide it.
async function gap(t, command, detail, stderr) {
  const r = await t.run(command)
  assert.deepEqual(r.unsupported.map((u) => u.detail), [detail], command)
  assert.equal(r.stderr, stderr, command)
  assert.notEqual(r.exitCode, 0, command)
  return r
}

const NAMES = 'pkg/\npkg/README.md\npkg/bin/\npkg/bin/run.sh\npkg/empty/\npkg/link\npkg/src/\npkg/src/index.js\npkg/src/lib/\npkg/src/lib/numbers.txt\npkg/src/lib/util.js\n'
const LONG = [
  'drwxr-xr-x dev/staff         0 2024-05-06 07:08 pkg/',
  '-rw-r--r-- dev/staff         6 2024-05-06 07:08 pkg/README.md',
  'drwxr-xr-x dev/staff         0 2024-05-06 07:08 pkg/bin/',
  '-rwxr-xr-x dev/staff        19 2024-05-06 07:08 pkg/bin/run.sh',
  'drwxr-xr-x dev/staff         0 2024-05-06 07:08 pkg/empty/',
  'lrwxrwxrwx dev/staff         0 2024-05-06 07:08 pkg/link -> README.md',
  'drwxr-xr-x dev/staff         0 2024-05-06 07:08 pkg/src/',
  '-rw-r--r-- dev/staff        19 2024-05-06 07:08 pkg/src/index.js',
  'drwxr-xr-x dev/staff         0 2024-05-06 07:08 pkg/src/lib/',
  '-rw-r--r-- dev/staff      1492 2024-05-06 07:08 pkg/src/lib/numbers.txt',
  '-rw-r--r-- dev/staff        34 2024-05-06 07:08 pkg/src/lib/util.js',
]
const lines = (...picked) => picked.map((line) => line + '\n').join('')

describe('tar lists what an archive holds', () => {
  it('names every entry, and with -v describes it', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('tar -tf pkg.tar'), result(NAMES))
    assert.deepEqual(await t.run('tar -tvf pkg.tar'), result(lines(...LONG)))
    // The old style: the letters of a first word with no dash, their
    // arguments taken from the words after it.
    assert.deepEqual(await t.run('tar tvf pkg.tar pkg/src'), result(lines(...LONG.slice(6))))
    assert.deepEqual(await t.run('tar -tvf pkg.tar --numeric-owner pkg/README.md'), result('-rw-r--r-- 1000/50           6 2024-05-06 07:08 pkg/README.md\n'))
    assert.deepEqual(await t.run('tar -tvf pkg.tar --utc pkg/empty'), result(lines(LONG[4])))
  })

  it('describes what is not a file the way GNU does', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('tar -tvf sp.tar'), result(lines(
      'drwxr-xr-x 0/0               0 2024-05-06 07:08 sp/',
      'crw-r--r-- 0/0             1,3 2024-05-06 07:08 sp/cdev',
      '-rw-r--r-- 0/0               5 2024-05-06 07:08 sp/f',
      'prw-r--r-- 0/0               0 2024-05-06 07:08 sp/fifo',
      'hrw-r--r-- 0/0               0 2024-05-06 07:08 sp/hard link to sp/f',
    )))
  })

  it('reads a gzip archive with -z, and without it from a file that says it is one', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('tar -tzf pkg.tgz'), result(NAMES))
    assert.deepEqual(await t.run('tar -tf pkg.tgz pkg/src/lib'), result('pkg/src/lib/\npkg/src/lib/numbers.txt\npkg/src/lib/util.js\n'))
    assert.deepEqual(await t.run('tar -tvzf pkg.tgz pkg/bin/run.sh pkg/link'), result(lines(LONG[3], LONG[5])))
    // stdin is read with -z, and GNU asks to be told rather than looking.
    assert.deepEqual(await t.run('cat pkg.tgz | tar -tz pkg/README.md'), result('pkg/README.md\n'))
    assert.deepEqual(await t.run('cat pkg.tgz | tar -t'), result('', { stderr: 'tar: Archive is compressed. Use -z option\ntar: Error is not recoverable: exiting now\n', exitCode: 2 }))
    assert.deepEqual(await t.run('cat pkg.tar | tar -tv pkg/bin'), result(lines(LONG[2], LONG[3])))
  })

  it("passes gzip's own complaint on, and its status", async () => {
    const t = await terminal()
    const child = 'tar: Child returned status 1\ntar: Error is not recoverable: exiting now\n'
    assert.deepEqual(await t.run('tar -tzf pkg.tar'), result('', { stderr: '\ngzip: stdin: not in gzip format\n' + child, exitCode: 2 }))
    assert.deepEqual(await t.run('tar -tzf empty.zip'), result('', { stderr: '\ngzip: stdin: not in gzip format\n' + child, exitCode: 2 }))
    // Garbage after the last member is a warning gzip exits 2 on, having
    // written every member — which tar reads, before the status stops it
    // short of saying what it did not find.
    const garbage = '\ngzip: stdin: decompression OK, trailing garbage ignored\ntar: Child returned status 2\ntar: Error is not recoverable: exiting now\n'
    assert.deepEqual(await t.run('tar -tzf trailing.tgz pkg/README.md'), result('pkg/README.md\n', { stderr: garbage, exitCode: 2 }))
    assert.deepEqual(await t.run('tar -tf trailing.tgz pkg/nothere'), result('', { stderr: garbage, exitCode: 2 }))
    // A member cut short leaves gzip writing out what it had inflated by
    // then, which the runtime's stream does not say.
    await gap(t, 'tar -tzf cut.tgz', 'damaged gzip stream', 'tar: the gzip stream is damaged, and how much of it GNU gzip would inflate is not known here\n')
  })

  it('matches operands against what is stored, and reports what it did not find', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run("tar -tf pkg.tar pkg/nothere 'pkg/*.md' pkg/src/"), result('pkg/src/\npkg/src/index.js\npkg/src/lib/\npkg/src/lib/numbers.txt\npkg/src/lib/util.js\n', {
      stderr: 'tar: pkg/nothere: Not found in archive\ntar: Pattern matching characters used in file names\n'
        + 'tar: Use --wildcards to enable pattern matching, or --no-wildcards to suppress this warning\n'
        + 'tar: pkg/*.md: Not found in archive\ntar: Exiting with failure status due to previous errors\n',
      exitCode: 2,
    }))
  })

  it('says what GNU says of what is not an archive at all', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('tar -t < /dev/null'), result('', { stderr: 'tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors\n', exitCode: 2 }))
    assert.deepEqual(await t.run('tar -tf notes.txt'), result('', { stderr: 'tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors\n', exitCode: 2 }))
    assert.deepEqual(await t.run('tar -tf notes.txt pkg/README.md'), result('', {
      stderr: 'tar: This does not look like a tar archive\ntar: pkg/README.md: Not found in archive\ntar: Exiting with failure status due to previous errors\n',
      exitCode: 2,
    }))
    assert.deepEqual(await t.run('tar -tf missing.tar'), result('', { stderr: 'tar: missing.tar: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n', exitCode: 2 }))
    assert.deepEqual(await t.run('tar -tf pkg'), result('', {
      stderr: 'tar: pkg: Cannot read: Is a directory\ntar: At beginning of tape, quitting now\ntar: Error is not recoverable: exiting now\n',
      exitCode: 2,
    }))
  })

  it('refuses an archive whose names it cannot give back as stored', async () => {
    // The package reads `./a` as `a`; GNU lists it as it was stored.
    const t = await terminal()
    await gap(t, 'tar -tf dot.tar', 'dot-segment names', 'tar: names stored with `./` in front are not supported\n')
  })
})

describe('tar reads its command line as GNU does', () => {
  const usage = (message, exitCode = 2) => result('', { stderr: `tar: ${message}\nTry 'tar --help' or 'tar --usage' for more information.\n`, exitCode })

  it('says what is wrong with it in GNU words', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('tar'), usage("You must specify one of the '-Acdtrux', '--delete' or '--test-label' options"))
    assert.deepEqual(await t.run('tar -ctf x'), usage("You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option"))
    assert.deepEqual(await t.run('tar -cf x.tar'), usage('Cowardly refusing to create an empty archive'))
    assert.deepEqual(await t.run('tar cf'), usage("Old option 'f' requires an argument."))
    assert.deepEqual(await t.run('tar -tf'), usage("option requires an argument -- 'f'", 64))
    assert.deepEqual(await t.run('tar --file'), usage("option '--file' requires an argument", 64))
    assert.deepEqual(await t.run('tar -tvf pkg.tar --verbose=1'), usage("option '--verbose' doesn't allow an argument", 64))
    assert.deepEqual(await t.run('tar -tf pkg.tar --strip-components=abc'), usage('abc: Invalid number of elements'))
    assert.deepEqual(await t.run('tar -tf pkg.tar -f pkg.tar'), usage("Multiple archive files require '-M' option"))
    assert.deepEqual(await t.run('tar -cf x -b 0 pkg'), usage('0: Invalid blocking factor'))
    assert.deepEqual(await t.run('tar -cf x --format=foo pkg'), usage('foo: Invalid archive format'))
    // argmatch quotes in the locale's own marks.
    assert.deepEqual(await t.run('tar -cf x --sort=n pkg'), result('', {
      stderr: 'tar: ambiguous argument ‘n’ for ‘--sort’\nValid arguments are:\n  - ‘none’\n  - ‘name’\n  - ‘inode’\n',
      exitCode: 2,
    }))
  })

  it('reports an option it does not carry as a gap', async () => {
    const t = await terminal()
    await gap(t, 'tar -cjf x.tbz pkg', '-j', 'tar: unknown option: -j\n')
    await gap(t, 'tar -tf pkg.tar --wildcards', '--wildcards', 'tar: unknown option: --wildcards\n')
    // A compressor other than gzip, known by its name or its first bytes.
    await gap(t, 'tar -tf fake.xz', '-J', 'tar: -J: archives compressed other than with gzip are not supported\n')
    // A tar is a tar whatever its name says.
    assert.deepEqual(await t.run('cp pkg.tar /tmp/pkg.tar.xz && tar -tf /tmp/pkg.tar.xz pkg/README.md'), result('pkg/README.md\n'))
  })
})

describe('tar extracts into the writable overlay', () => {
  it('writes every entry where -C says, as GNU writes it', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('cd /tmp && cp /repo/pkg.tar /repo/pkg.tgz . && mkdir out && tar -xf pkg.tar -C out && find out | sort && cat out/pkg/link'), result(
      'out\nout/pkg\nout/pkg/README.md\nout/pkg/bin\nout/pkg/bin/run.sh\nout/pkg/empty\nout/pkg/link\nout/pkg/src\nout/pkg/src/index.js\nout/pkg/src/lib\nout/pkg/src/lib/numbers.txt\nout/pkg/src/lib/util.js\n# pkg\n',
      { cwd: '/tmp' },
    ))
    assert.deepEqual(await t.run('tar -xvf pkg.tar -C out pkg/src'), result('pkg/src/\npkg/src/index.js\npkg/src/lib/\npkg/src/lib/numbers.txt\npkg/src/lib/util.js\n', { cwd: '/tmp' }))
    assert.deepEqual(await t.run('tar -xkf pkg.tar -C out pkg/README.md'), result('', {
      stderr: 'tar: pkg/README.md: Cannot open: File exists\ntar: Exiting with failure status due to previous errors\n', exitCode: 2, cwd: '/tmp',
    }))
    // -O writes the files to stdout, which moves the names to stderr.
    assert.deepEqual(await t.run('tar -xvOf pkg.tar pkg/src/index.js pkg/README.md'), result('# pkg\nexport const x = 1\n', { stderr: 'pkg/README.md\npkg/src/index.js\n', cwd: '/tmp' }))
    // --strip-components takes leading names off, and passes over an entry
    // it takes everything from; -v names what is stored.
    assert.deepEqual(await t.run('mkdir s && tar -xvzf pkg.tgz -C s --strip-components=2 && find s | sort'), result(
      'pkg/bin/run.sh\npkg/src/index.js\npkg/src/lib/\npkg/src/lib/numbers.txt\npkg/src/lib/util.js\ns\ns/index.js\ns/lib\ns/lib/numbers.txt\ns/lib/util.js\ns/run.sh\n',
      { cwd: '/tmp' },
    ))
  })

  it('unlinks what stands in the way, and keeps a directory that is not empty', async () => {
    const t = await terminal()
    assert.deepEqual(await t.run('cd /tmp && mkdir -p c/pkg/README.md/x && echo old > c/pkg/link && tar -xvf /repo/pkg.tar -C c pkg/README.md pkg/link; echo $?'), result('pkg/README.md\npkg/link\n2\n', {
      stderr: 'tar: pkg/README.md: Cannot open: File exists\ntar: Exiting with failure status due to previous errors\n', cwd: '/tmp',
    }))
    // The file in the link's way is gone, and the link is what the archive says.
    assert.match((await t.run('ls -l c/pkg/link')).stdout, / c\/pkg\/link -> README\.md\n$/u)
  })

  it('enters each -C as the entries it applies to come up', async () => {
    const t = await terminal()
    const fatal = 'tar: nodir: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n'
    assert.deepEqual(await t.run('cd /tmp && tar -xf /repo/pkg.tar -C nodir'), result('', { stderr: fatal, exitCode: 2, cwd: '/tmp' }))
    assert.deepEqual(await t.run('tar -tf /repo/pkg.tar -C nodir'), result('', { stderr: fatal, exitCode: 2, cwd: '/tmp' }))
    assert.deepEqual(await t.run('tar -xvf /repo/pkg.tar -C . pkg/README.md -C nodir pkg/link'), result('pkg/README.md\n', { stderr: fatal, exitCode: 2, cwd: '/tmp' }))
    assert.equal((await t.run('cat pkg/README.md')).stdout, '# pkg\n')
  })

  it('reports a write it cannot make here as a gap', async () => {
    const t = await terminal()
    // Outside /tmp is the read-only filesystem every other write meets.
    await gap(t, 'tar -xf pkg.tar', 'read-only target', 'tar: pkg: Cannot mkdir: Read-only file system\n')
    // The overlay holds no hard links and no devices.
    await gap(t, 'tar -xf sp.tar -C /tmp sp/hard', 'link', 'tar: sp/hard: extracting hard links is not supported\n')
    await gap(t, 'tar -xf sp.tar -C /tmp sp/fifo', 'fifo', 'tar: sp/fifo: extracting special files is not supported\n')
  })
})

// The tree GNU was run over for the archives below, as this terminal holds
// it: every file `-rw-------`, every directory `drwx------`, the link
// `lrwxrwxrwx`, all dated to MADE — `touch -h -d @1789710720` over the lot.
const MADE = Date.UTC(2026, 8, 18, 5, 52)
const TREE = {
  'src/a.txt': 'hello\n',
  'src/sub/b.txt': 'b\n',
  'src/big.txt': Array.from({ length: 2000 }, (_, i) => `${i + 1}\n`).join(''),
  'src/link': { type: 'link', target: 'a.txt' },
}
async function stopped(fn) {
  mock.timers.enable({ apis: ['Date'], now: MADE })
  try { return await fn() } finally { mock.timers.reset() }
}

describe('tar writes the archive GNU writes', () => {
  it('byte for byte, given the owners it has no numbers for', async () => {
    const t = await stopped(() => createTerminal(TREE, { mount: '/repo', writable: '/tmp/' }))
    // `tar --sort=name OPTIONS -cf x.tar src | sha256sum`, over that tree.
    const cases = [
      ['--owner=0 --group=0 --numeric-owner', 'e9b6fd5f774d02c2abbb4344ed0245453551377853c6e5465cf6944dafe70d01'],
      ['--owner=user:1000 --group=user:1000', '40bc83898c629725f8b04860df6064c57e8b729fe566f2714c9ee8e956f05d58'],
      ['--format=ustar --owner=0 --group=0 --numeric-owner', 'cb5daf84d306b6b3689e6c031d035d60186eac290c2cb8768a915a87282e9454'],
      ['-b 1 --owner=0 --group=0 --numeric-owner', 'd8016f50d5d43527ac9e4bab862ce5e2fe3719ca38230b88147b2d4d518ebede'],
    ]
    for (const [options, sum] of cases) {
      assert.deepEqual(await t.run(`tar -cf /tmp/x.tar ${options} src && sha256sum /tmp/x.tar`), result(`${sum}  /tmp/x.tar\n`), options)
    }
    // Through gzip, and back.
    assert.deepEqual(await t.run('tar -czf /tmp/x.tgz --owner=0 --group=0 --numeric-owner src && gzip -dc /tmp/x.tgz | sha256sum'), result(`${cases[0][1]}  -\n`))
  })

  it('refuses to make up the numbers an archive records', async () => {
    const t = await terminal(TREE)
    const message = 'tar: the files here have no numeric owner or group to record; give them with --owner=NAME:UID and --group=NAME:GID, or as ids with --numeric-owner\n'
    await gap(t, 'tar -cf /tmp/x.tar src', 'file owners', message)
    await gap(t, 'tar -cf /tmp/x.tar --owner=root --group=root src', 'file owners', message)
    await gap(t, 'tar -cf /tmp/x.tar --owner=0 --group=0 src', 'file owners', message)
    // A number GNU cannot read is its own error, before anything else.
    assert.deepEqual(await t.run('tar -cf /tmp/x.tar --owner=user:abc src'), result('', { stderr: 'tar: abc: Invalid owner or group ID\ntar: Error is not recoverable: exiting now\n', exitCode: 2 }))
    // A pax header carries times this tree does not have.
    await gap(t, 'tar -cf /tmp/x.tar --format=pax --owner=0 --group=0 --numeric-owner src', '--format=pax', 'tar: the pax format records access and change times, which this tree does not have\n')
  })
})

describe('tar names what it stores as GNU does', () => {
  const own = '--owner=0 --group=0 --numeric-owner'

  it('takes a leading slash or climb off, once per prefix', async () => {
    const t = await terminal(TREE)
    assert.deepEqual(await t.run(`tar -cvf /tmp/x.tar ${own} /repo/src/a.txt ../repo/src/sub && tar -tf /tmp/x.tar`), result('/repo/src/a.txt\n../repo/src/sub/\n../repo/src/sub/b.txt\nrepo/src/a.txt\nrepo/src/sub/\nrepo/src/sub/b.txt\n', {
      stderr: "tar: Removing leading `/' from member names\ntar: Removing leading `/' from hard link targets\ntar: Removing leading `../' from member names\ntar: Removing leading `../' from hard link targets\n",
    }))
  })

  it('reports what it could not find, and goes on', async () => {
    const t = await terminal(TREE)
    assert.deepEqual(await t.run(`tar -cf /tmp/x.tar ${own} src/a.txt missing src/link; tar -tf /tmp/x.tar`), result('src/a.txt\nsrc/link\n', {
      stderr: 'tar: missing: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\n',
    }))
  })

  it('moves operands with -C, and says so of one that moves nothing', async () => {
    const t = await terminal(TREE)
    assert.deepEqual(await t.run(`tar -cvf /tmp/x.tar ${own} -C src a.txt -C sub b.txt -C /tmp`), result('a.txt\nb.txt\n', {
      stderr: 'tar: The following options were used after non-option arguments.  These options are positional and affect only arguments that follow them.  Please, rearrange them properly.\n'
        + "tar: -C ‘/tmp’ has no effect\ntar: Exiting with failure status due to previous errors\n",
      exitCode: 2,
    }))
    // A -C it cannot enter ends the run, and leaves the archive with only
    // the whole records it had written: none, here.
    assert.deepEqual(await t.run(`tar -cf /tmp/y.tar ${own} src/a.txt -C nodir x; wc -c < /tmp/y.tar`), result('0\n', {
      stderr: 'tar: nodir: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n',
    }))
  })

  it('leaves the archive itself out of what it walks', async () => {
    const t = await terminal(TREE)
    assert.deepEqual(await t.run(`mkdir /tmp/w && echo x > /tmp/w/f && tar -cf /tmp/w/self.tar ${own} /tmp/w && tar -tf /tmp/w/self.tar`), result('tmp/w/\ntmp/w/f\n', {
      stderr: "tar: Removing leading `/' from member names\ntar: /tmp/w/self.tar: archive cannot contain itself; not dumped\n",
    }))
  })

  it('writes to stdout, and lists on stderr when it does', async () => {
    const t = await terminal(TREE)
    assert.deepEqual(await t.run(`tar -cvf - ${own} src/sub | tar -t`), result('src/sub/\nsrc/sub/b.txt\n', { stderr: 'src/sub/\nsrc/sub/b.txt\n' }))
    // -a picks gzip by the name.
    assert.deepEqual(await t.run(`tar -caf /tmp/a.tgz ${own} src/a.txt && tar -tzf /tmp/a.tgz`), result('src/a.txt\n'))
  })

  it('refuses a name the package would store differently', async () => {
    const t = await terminal(TREE)
    // GNU stores `./a.txt`; the package would store `a.txt`.
    await gap(t, `tar -cf /tmp/x.tar ${own} -C src .`, 'dot-segment names', "tar: ./a.txt: member names with `.' or empty segments are not supported\n")
  })
})
