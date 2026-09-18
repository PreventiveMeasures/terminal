// Records what GNU grep matches case-insensitively for every character with
// a case in glibc's C.UTF-8, into grep-folds.txt: one line per character,
// its code point and then those of the lines `grep -i` selected from a file
// holding every such character on a line of its own. Run once, with grep and
// glibc's C.UTF-8 at hand; tests/locale-tables.test.js holds fold() in
// src/locale.js to it.
//
//   node tests/fixtures/locale/record-grep-folds.mjs

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env, stdout } from 'node:process'
import { URL } from 'node:url'
import { TOLOWER, TOUPPER } from '../../../src/locale-data.js'

// Every character either mapping names: the ones with a case.
const starts = (text) => text.split(',').flatMap((run) => {
  const [from, count, , stride] = run.split(':').map((n) => parseInt(n, 36))
  return Array.from({ length: count }, (_, i) => from + i * stride)
})
const cased = [...new Set([...starts(TOUPPER), ...starts(TOLOWER)])].sort((a, b) => a - b)

const dir = mkdtempSync(join(tmpdir(), 'folds-'))
try {
  const file = join(dir, 'chars.txt')
  writeFileSync(file, cased.map((c) => String.fromCodePoint(c)).join('\n') + '\n')
  const version = execFileSync('grep', ['--version'], { encoding: 'utf8' }).split('\n')[0]
  const lines = cased.map((code) => {
    let out = ''
    try {
      out = execFileSync('grep', ['-inxF', '--', String.fromCodePoint(code), file], { encoding: 'utf8', env: { ...env, LC_ALL: 'C.UTF-8' } })
    } catch (e) {
      if (e.status !== 1) throw e
    }
    const matched = out.split('\n').filter(Boolean).map((line) => cased[Number(line.split(':')[0]) - 1])
    return [code, ...matched].map((c) => c.toString(16)).join(' ')
  })
  const text = [
    `# What \`grep -i\` matches for each character with a case in glibc's C.UTF-8,`,
    `# recorded from ${version} by record-grep-folds.mjs: the character's code`,
    '# point, then those of every character it selected, ascending.',
    ...lines,
  ].join('\n') + '\n'
  writeFileSync(new URL('./grep-folds.txt', import.meta.url), text)
  stdout.write(`recorded ${cased.length} characters from ${version}\n`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
