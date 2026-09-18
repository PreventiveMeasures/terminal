// Records glibc's C.UTF-8 character classes and case mappings into
// src/locale-data.js, by asking the library itself: a small C program calls
// iswctype, towupper and towlower for every code point under
// setlocale(LC_ALL, "C.UTF-8") and prints what it finds. Run it once, on a
// machine with gcc and a glibc that ships C.UTF-8 (2.35 or later); the module
// it writes is what the package carries, and tests/locale-tables.test.js
// holds it to the glibc it runs on wherever one is available.
//
//   node tests/fixtures/locale/record-c-utf8.mjs
//
// Each class is its code point ranges, ascending, as base-36 pairs of the gap
// from the previous range and the length of this one. Each case mapping is a
// list of runs: a first code point, how many follow it at a fixed stride, and
// the offset every one of them maps by. src/locale.js decodes both.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argv, exit, stdout } from 'node:process'
import { URL } from 'node:url'

export const NAMES = ['alpha', 'digit', 'alnum', 'upper', 'lower', 'space', 'blank', 'punct', 'xdigit', 'cntrl', 'print', 'graph']

const SOURCE = `
#include <gnu/libc-version.h>
#include <locale.h>
#include <stdio.h>
#include <wctype.h>
static const char *names[] = { ${NAMES.map((n) => JSON.stringify(n)).join(', ')} };
int main(void) {
  if (!setlocale(LC_ALL, "C.UTF-8")) return 1;
  printf("{\\"glibc\\":\\"%s\\",\\"classes\\":{", gnu_get_libc_version());
  for (unsigned n = 0; n < sizeof names / sizeof *names; n++) {
    wctype_t t = wctype(names[n]);
    printf("%s\\"%s\\":[", n ? "," : "", names[n]);
    long lo = -1; int first = 1;
    for (long c = 0; c <= 0x110000; c++) {
      int in = c < 0x110000 && !(c >= 0xD800 && c <= 0xDFFF) && iswctype((wint_t) c, t);
      if (in && lo < 0) lo = c;
      if (!in && lo >= 0) { printf("%s[%ld,%ld]", first ? "" : ",", lo, c - 1); first = 0; lo = -1; }
    }
    printf("]");
  }
  printf("},\\"toupper\\":[");
  int first = 1;
  for (long c = 0; c < 0x110000; c++) {
    long u = c >= 0xD800 && c <= 0xDFFF ? c : (long) towupper((wint_t) c);
    if (u != c) { printf("%s[%ld,%ld]", first ? "" : ",", c, u); first = 0; }
  }
  printf("],\\"tolower\\":[");
  first = 1;
  for (long c = 0; c < 0x110000; c++) {
    long l = c >= 0xD800 && c <= 0xDFFF ? c : (long) towlower((wint_t) c);
    if (l != c) { printf("%s[%ld,%ld]", first ? "" : ",", c, l); first = 0; }
  }
  printf("]}\\n");
  return 0;
}
`

// What glibc reports: { glibc, classes: { name: [[lo, hi], …] }, toupper: [[from, to], …],
// tolower: [[from, to], …] }, or null where there is no gcc or no C.UTF-8 to ask.
export function recordTables() {
  const dir = mkdtempSync(join(tmpdir(), 'c-utf8-'))
  try {
    writeFileSync(join(dir, 'tables.c'), SOURCE)
    execFileSync('gcc', ['-O2', '-o', join(dir, 'tables'), join(dir, 'tables.c')], { stdio: ['ignore', 'ignore', 'ignore'] })
    return JSON.parse(execFileSync(join(dir, 'tables'), { encoding: 'utf8', maxBuffer: 1 << 24 }))
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function encodeRanges(ranges) {
  let prev = -1
  return ranges.map(([lo, hi]) => {
    const pair = `${(lo - prev - 1).toString(36)}:${(hi - lo).toString(36)}`
    prev = hi
    return pair
  }).join(',')
}

// Mappings mostly come in runs — A–Z all by 32, the Latin Extended-A pairs
// alternating by 1 — so each run is one entry: start, count, offset, stride.
export function encodeMapping(pairs) {
  const runs = []
  for (const [from, to] of pairs) {
    const last = runs.at(-1)
    const offset = to - from
    if (last && last.offset === offset && from === last.from + last.count * last.stride) { last.count++; continue }
    if (last && last.count === 1 && last.offset === offset && (from - last.from === 1 || from - last.from === 2)) { last.stride = from - last.from; last.count = 2; continue }
    runs.push({ from, count: 1, offset, stride: 1 })
  }
  return runs.map((r) => `${r.from.toString(36)}:${r.count.toString(36)}:${r.offset.toString(36)}:${r.stride}`).join(',')
}

export function render({ glibc, classes, toupper, tolower }) {
  const lines = NAMES.map((name) => `  ${name}: '${encodeRanges(classes[name])}',`)
  return `// glibc ${glibc}'s C.UTF-8 character classes and case mappings, recorded from
// the library itself by tests/fixtures/locale/record-c-utf8.mjs and held to
// the glibc the tests run on by tests/locale-tables.test.js. A class is its
// code point ranges, ascending, as base-36 pairs of the gap from the previous
// range and the length of this one; a mapping is runs of start, count, offset
// and stride. src/locale.js decodes them on first use.
export const GLIBC = ${JSON.stringify(glibc)}
export const CLASSES = {
${lines.join('\n')}
}
export const TOUPPER = '${encodeMapping(toupper)}'
export const TOLOWER = '${encodeMapping(tolower)}'
`
}

if (argv[1] === import.meta.filename) {
  const recorded = recordTables()
  if (!recorded) { stdout.write('no gcc or no C.UTF-8 locale here; nothing recorded\n'); exit(1) }
  writeFileSync(new URL('../../../src/locale-data.js', import.meta.url), render(recorded))
  stdout.write(`recorded glibc ${recorded.glibc}: ${NAMES.map((n) => `${n} ${recorded.classes[n].length}`).join(', ')}; ${recorded.toupper.length} upper and ${recorded.tolower.length} lower mappings\n`)
}
