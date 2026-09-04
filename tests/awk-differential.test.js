// awk against the reference implementation. Every case here runs
// through gawk and through the virtual terminal, and the two must
// agree: same stdout, same failed-or-not status. gawk is the reference
// because the dialect follows it wherever awks differ; the cases were
// assembled while aligning the interpreter with gawk 5.2.1 and cover
// fields and records, patterns, print/printf, the value model,
// builtins, control flow, files and getline, regex semantics, the gawk
// extensions, and the error paths. A few cases carry an `expect`:
//   reject    the terminal must refuse the program visibly (a process,
//             a file write, an unsupported extension); gawk would run it
//   sorted    output order is unspecified (for-in), compare sorted
//   locale    gawk here runs in the C locale (bytes); the terminal is
//             character based, as gawk is under UTF-8
//   nansign   JS has no NaN sign bit; gawk prints +nan / -nan
// The generated sections re-run seeded fuzzers over expressions,
// regexes, printf formats and field/record splitting.
//
// Skipped (not failed) when gawk is not installed.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { describe, it } from 'node:test'

import { createTerminal } from '@preventive/terminal'

const GAWK = spawnSync('gawk', ['--version']).status === 0

const NUMS = '10 9 abc 0 1e2 0x10 - 3.0 +5 .5\n'

// Runs one case through gawk. The program travels via `-f prog.awk`;
// `input` becomes the operand `in.txt` unless `stdin` is set.
function runGawk(c) {
  const dir = mkdtempSync(join(tmpdir(), 'awkdiff-'))
  try {
    const files = { ...c.files, 'prog.awk': c.prog }
    if (c.input !== undefined) files['in.txt'] = c.input
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    const operands = c.operands ?? (c.input !== undefined && !c.stdin ? ['in.txt'] : [])
    const r = spawnSync('gawk', [...(c.args ?? []), '-f', 'prog.awk', ...operands], {
      cwd: dir, input: c.stdin ? c.input ?? '' : '', env: { ...process.env, LC_ALL: 'C' }, timeout: 10000, maxBuffer: 64 << 20,
    })
    return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.status ?? -1 }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function runMine(c) {
  const files = { ...c.files, 'prog.awk': c.prog }
  if (c.input !== undefined) files['in.txt'] = c.input
  const operands = c.operands ?? (c.input !== undefined && !c.stdin ? ['in.txt'] : [])
  const argv = [...(c.args ?? []), '-f', 'prog.awk', ...operands].map((a) => `'${a}'`).join(' ')
  const r = createTerminal(files).run(`${c.stdin ? 'cat in.txt | ' : ''}awk ${argv}`)
  return { out: r.stdout, err: r.stderr, code: r.exitCode }
}

const sorted = (s) => s.split('\n').sort().join('\n')

function check(c) {
  const mine = runMine(c)
  if (c.expect === 'reject') {
    assert.notEqual(mine.code, 0, 'must be refused')
    assert.match(mine.err, /not supported|read-only|must be a variable|unexpected/u)
    return
  }
  if (c.expect === 'locale' || c.expect === 'nansign') return
  const ref = runGawk(c)
  const label = JSON.stringify(c.prog).slice(0, 160)
  assert.equal(mine.code !== 0, ref.code !== 0, `${label}: gawk exit ${ref.code}, terminal exit ${mine.code} (${mine.err.split('\n')[0]})`)
  if (c.expect === 'sorted') assert.equal(sorted(mine.out), sorted(ref.out), label)
  else assert.equal(mine.out, ref.out, label)
  assert.equal(mine.err !== '', ref.err !== '', `${label}: stderr presence (gawk: ${JSON.stringify(ref.err)}, terminal: ${JSON.stringify(mine.err)})`)
}

const SECTIONS = {
  fields: [
    {"prog":"{ print $1 }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"{ print $NF, $(NF-1), NF, NR }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"{ print $0 }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"{ print }","input":"a\n\nb\n"},
    {"prog":"{ print NF }","input":"  a   b  \n\n\t\tx\t\n"},
    {"prog":"{ print NF, $3 }","args":["-F:"],"input":"root:x:0:0:root:/root:/bin/bash\nann:x:1000:1000::/home/ann:/bin/zsh\n"},
    {"prog":"{ print $2 }","args":["-F","\\t"],"input":"a\tb\t\tc\n"},
    {"prog":"{ print NF, $2 }","args":["-F","\\t"],"input":"a\tb\t\tc\n\tq\n"},
    {"prog":"{ print $2, NF }","args":["-F","."],"input":"a.b.c\n"},
    {"prog":"{ print $2, NF }","args":["-F","|"],"input":"a|b|c\n"},
    {"prog":"{ print $2, NF }","args":["-F","[0-9]+"],"input":"a1b22c\n"},
    {"prog":"{ print $2 \"|\" $3 }","args":["-F",", *"],"input":"a, b,c\n"},
    {"prog":"{ print NF \"[\" $2 \"]\" }","args":["-F:"],"input":"a::c\n"},
    {"prog":"{ print NF, $1 }","args":["-F"," "],"input":"  a b  \n"},
    {"prog":"{ print NF, $2 }","args":["-F",""],"input":"abc\n"},
    {"prog":"BEGIN { FS = \":\" } { print $1 }","input":"root:x:0:0:root:/root:/bin/bash\nann:x:1000:1000::/home/ann:/bin/zsh\n"},
    {"prog":"{ FS = \":\"; print $1 }","input":"a:b\nc:d\n"},
    {"prog":"{ FS = \":\"; $0 = $0; print $1 }","input":"a:b\nc:d\n"},
    {"prog":"{ print NF }","args":["-F","[ ]"],"input":" a  b \n"},
    {"prog":"BEGIN { FS = \"  \" } { print NF }","input":" a  b \n"},
    {"prog":"{ print NF, $2 }","args":["-F","^x"],"input":"xaxb\n"},
    {"prog":"{ $5 = \"x\"; print; print NF }","input":"a b\n"},
    {"prog":"{ NF = 1; print; print NF }","input":"a b c\n"},
    {"prog":"{ NF = 4; print; print NF }","input":"a b\n"},
    {"prog":"BEGIN { OFS = \"-\" } { $1 = $1; print }","input":"a  b   c\n"},
    {"prog":"BEGIN { OFS = \"-\" } { print; print $1, $2 }","input":"a  b   c\n"},
    {"prog":"{ $0 = \"x y\"; print NF, $2; $3 = \"z\"; print $0, NF }","input":"a b c\n"},
    {"prog":"{ NF = 0; print \"[\" $0 \"]\"; $1 = \"q\"; print; print NF }","input":"a b\n"},
    {"prog":"{ $3 = \"c\"; print NF; print length($2) }","input":"a\n"},
    {"prog":"BEGIN { $3 = \"c\"; print NF, \"[\" $0 \"]\"; $0 = \"  p   q  \"; print NF, $1 \"|\" $2 }"},
    {"prog":"{ $2 = 0.1 + 0.2; print; CONVFMT = \"%.2g\"; $1 = 3.14159; print; print $1 }","input":"a b\n"},
    {"prog":"BEGIN { $0 = 3.14159265; print; print $0 + 0, NF, $1 }"},
    {"prog":"{ print $1 < 9; $1 = $1; print ($0 < 9) }","input":"10\n"},
    {"prog":"{ $2 = \"x\"; print ($0 < 9), ($1 < 9) }","input":"10\n"},
    {"prog":"{ $0 = $0; print ($0 < 9), ($1 < 9) }","input":"10\n"},
    {"prog":"{ $0 = \"10\"; print ($0 < 9), ($1 < 9) }","input":"10\n"},
    {"prog":"{ sub(/1/, \"1\"); print ($0 < 9); }","input":"10\n"},
    {"prog":"{ print $(1.9), $\"2\", $$1 }","input":"2 b c\n"},
    {"prog":"{ print \"[\" $100 \"]\", NF }","input":"a\n"},
    {"prog":"BEGIN { RS = \";\" } { print NR, $0 } END { print NR }","input":"a;b;c;"},
    {"prog":"BEGIN { RS = \";\" } { print NR, \"[\" $0 \"]\" } END { print NR }","input":"a;b;;c"},
    {"prog":"BEGIN { RS = \"\" } { print NR \": \" NF, $1, $NF; print \"[\" $0 \"]\" }","input":"a b\nc\n\n\nd e\nf\n"},
    {"prog":"BEGIN { RS = \"\"; FS = \":\" } { print NF; for (i = 1; i <= NF; i++) print i, \"[\" $i \"]\" }","input":"a:b\nc:d\n\ne\n"},
    {"prog":"BEGIN { RS = \"\"; FS = \"\\n\" } { print NF, $1 }","input":"a b\nc\n\nd\n"},
    {"prog":"BEGIN { RS = \"[0-9]+\" } { print NR \": [\" $0 \"]\" }","input":"a1b22c"},
    {"prog":"BEGIN { RS = \"[0-9]\" } { print NR \": [\" $0 \"]\" }","input":"a1b\n2c\n"},
    {"prog":"BEGIN { RS = \"\\n\\n\" } { print NR \": [\" $0 \"]\" }","input":"a\nb\n\nc\n"},
    {"prog":"NR == 1 { RS = \";\" } { print NR \": \" $0 }","input":"a\nb;c\nd"},
    {"prog":"{ print NR \": \" $NF } END { print \"[\" $0 \"]\", NF }","input":"p q\nr s"},
    {"prog":"END { print NR }","input":"p q\nr s"},
    {"prog":"END { print NR, \"[\" $0 \"]\" }","input":""},
    {"prog":"{ print \"[\" $NF \"]\", NF, $1 == \"\" }","input":"\n"},
    {"prog":"BEGIN { print NF, \"[\" $0 \"]\", \"[\" $1 \"]\" }"},
    {"prog":"{ print length($0), length }","input":"héllo\n","expect":"locale"},
  ],
  patterns: [
    {"prog":"/la$/","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"!/la$/","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"$2 > 28 && $3 == \"la\" { print $1 }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"$1 ~ /^[ab]/ { c++ } END { print c }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"NR > 1","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"NR == 2, NR == 3 { print $1 }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"/start/,/end/","input":"1\nstart\n2\nend\n3\nstart\n4\n"},
    {"prog":"/a/,/a/","input":"a\nb\na\nc\n"},
    {"prog":"NF","input":"one\n\n  \nfour\n"},
    {"prog":"!NF { print NR }","input":"one\n\n  \nfour\n"},
    {"prog":"length > 3","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"length($1) == 3 && NR % 2","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"$2","input":"1\n0\nabc\n\n0.0\n"},
    {"prog":"$1 == \"bob\" { print \"found\"; next } { print \"other\" }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"BEGIN { print \"b\" } END { print \"e\", NR }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"BEGIN { print 1 } BEGIN { print 2 } END { print 3 } END { print 4 }","input":"x\n"},
    {"prog":"NR==1;NR==3","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"/a/;/b/","input":"ab\nc\nb\n"},
    {"prog":"/x/\n{ print \"all:\" $0 }","input":"x\ny\n"},
    {"prog":"$0 ~ \"a.b\"","input":"a.b\naxb\nab\n"},
    {"prog":"$1 !~ /^a/","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
  ],
  print: [
    {"prog":"BEGIN { OFS = \"-\"; ORS = \"|\" } { print $1, $2 }","input":"x\ny\n"},
    {"prog":"{ print $1 \"=\" $2 }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"BEGIN { print 1 \" \" 2 + 3; print 1 -1; print 1 \" \" -1; print \"a\" 1 + 2 \"b\"; print 1 \" \" - 1 \" \" 2 }"},
    {"prog":"BEGIN { print(\"a\", \"b\"); print (\"a\")(\"b\"); print (1)(2), 3; print (1 > 2) ? \"y\" : \"n\"; x = 1; print (x == 1) }"},
    {"prog":"BEGIN { print }"},
    {"prog":"BEGIN { print \"\" }"},
    {"prog":"BEGIN { printf \"%-5s|%5s|%.2s|%c%c|%%\\n\", \"ab\", \"ab\", \"xyz\", 65, \"hello\" }"},
    {"prog":"BEGIN { printf \"%d %i %05d %+d % d %.3d %x %X %o %u\\n\", 3.99, -3.99, 42, 5, 5, 7, 255, 255, 8, -1 }"},
    {"prog":"BEGIN { printf \"%5.2f|%e|%E|%g|%g|%g|%G|%.3g|%#g\\n\", 3.14159, 12345.678, 12345.678, 100000, 1000000, 0.0001, 0.00001, 3.14159, 1 }"},
    {"prog":"BEGIN { printf \"%*d|%-*d|%.*f|%.*f|%*d|\\n\", 5, 42, 5, 42, 2, 3.14159, -1, 3.14159, -5, 42 }"},
    {"prog":"BEGIN { printf \"%#o %#x %#X %08.3f %-6d|%+.2f % .1f\\n\", 8, 255, 255, -3.14159, 42, 1, 1 }"},
    {"prog":"BEGIN { printf \"%d %d %s %s|%z|%\\n\", \"12abc\", \"abc\", 1e6, 100 / 3 }"},
    {"prog":"BEGIN { printf \"%5%|%z|%|%ld %lld %hd\\n\", 1, 2, 3 }"},
    {"prog":"{ printf(\"%-4s%s\\n\", $1, $2) }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"BEGIN { printf \"[%s][%c][%d][%5.2f]\\n\", \"\", \"\", u, u }"},
    {"prog":"BEGIN { printf \"%.0f %.0f %.0f %.1f %.2f %.0e %.1e %.2g %g %.3f\\n\", 0.5, 1.5, 2.5, 0.25, 0.125, 2.5, 0.125, 0.125, 2.5e-5, 1.0005 }"},
    {"prog":"BEGIN { printf \"%.1f %.1f %.1f %.2f %.0f %.0f\\n\", 0.05, 0.15, 0.35, 1.005, 3.5, 4.5 }"},
    {"prog":"BEGIN { printf \"%d %d %i\\n\", 1e30, -1e30, 2^63 }"},
    {"prog":"BEGIN { printf \"%x %u %o %X\\n\", -1, -1, -1, 2^40 }"},
    {"prog":"BEGIN { printf \"%s %s %d\\n\", $1, $2, $2 }","input":"007 1e2\n"},
    {"prog":"{ printf \"%s %s %d\\n\", $1, $2, $2 }","input":"007 1e2\n"},
    {"prog":"BEGIN { printf \"%c|%c|%c|%c\\n\", 65.9, \"65\", 65, \"\" }"},
    {"prog":"{ printf \"%c|%c\\n\", $1, $2 }","input":"65 abc\n"},
    {"prog":"BEGIN { printf \"%E %G %F %X|%5s|%-6d|%d\\n\", exp(1000), -exp(1000), log(-1), exp(1000), exp(1000), exp(1000), -exp(1000) }"},
    {"prog":"BEGIN { printf \"%s|%d|%.2f|%e|%g\\n\", \"+inf\" + 0, \"-nan\" + 0, \"+inf\" + 0, \"-inf\" + 0, \"+nan\" + 0 }","expect":"nansign"},
    {"prog":"BEGIN { printf \"%s\\n\", \"a\", \"b\" }"},
    {"prog":"BEGIN { printf \"%s %s\\n\", \"a\" }"},
    {"prog":"BEGIN { printf \"%d items\\n\", \"3 apples\" }"},
    {"prog":"BEGIN { printf \"%'d|%5'd\\n\", 1234567, 12 }"},
    {"prog":"BEGIN { OFS = 1; print \"a\", \"b\"; ORS = 0; print \"c\"; print \"d\" }"},
    {"prog":"BEGIN { print 1e6, 0.1 + 0.2, 1 / 3, 2 ^ 0.5, 2 ^ 53, 2 ^ 62, 1e21, 123456.7, 1234567.8, -0, -x, 0 * -1 }"},
    {"prog":"BEGIN { print 2^63, -2^63, 12345678901234567890, 1e300, 2^53 + 1, 1e19 + 1, 9223372036854775807 }"},
    {"prog":"BEGIN { print 1e100, 1.5e300, 2e-300, 123e5, 1e-320, 0.1 * 3, 1 - 0.9, 3.0000000000000004 }"},
    {"prog":"BEGIN { OFMT = \"%.2f\"; x = 3.14159; print x, x \"\"; CONVFMT = \"%.1f\"; print x \"\", 17 \"\", x }"},
    {"prog":"BEGIN { CONVFMT = \"%.2f\"; OFMT = \"%.4f\"; x = 3.14159265; print x; print x \"\"; print (x \"\") + 0; y = x; print y, y \"\" }"},
    {"prog":"BEGIN { print log(-1), -log(-1), exp(1000), -exp(1000), \"+inf\" + 0, \"-nan\" + 0, \"inf\" + 0, \"nan\" + 0, \"infinity\" + 0 }","expect":"nansign"},
    {"prog":"BEGIN { x = exp(1000); print x \"\", (x == x), (log(-1) == log(-1)), (x - x == x - x), (x - x != x - x), (x - x < 1) }"},
    {"prog":"BEGIN { x = -0.0; print x, x \"\", -x; printf \"%s %g %.1f %d\\n\", x, x, x, x }"},
    {"prog":"BEGIN { print 1e21 \"\", 1e19, 10000000000000000000, 100000000000000000000 }"},
    {"prog":"BEGIN { print 0x10, 011, .5e1, 5., 08, 0x1A + 1 }"},
    {"prog":"BEGIN { print 0.1 + 0.2 == 0.3, (0.1 + 0.2) \"\" == 0.3 \"\", 0.1 + 0.2 - 0.3 }"},
  ],
  values: [
    {"prog":"{ x = \"10\"; print ($1 < 9), ($1 < $2), (x < 9), (\"10\" < 9), (\"10\" < \"9\"), ($1 == 10), ($1 == \"10\"), (2 < 10), (\"2\" < \"10\") }","input":"10 9\n"},
    {"prog":"{ print ($1 == 3), ($2 == 0.5), ($3 == 3), ($4 == 100), ($5 == 16), ($6 == 0), ($6 > 5), ($6 == \"-\"), ($7 == 1), ($8 == 5) }","input":"+3 .5 3. 1e2 0x10 abc 1e +5\n"},
    {"prog":"BEGIN { print (u == 0), (u == \"\"), (u < 1), u + 0, \"[\" u \"]\", !u, !\"0\", !\"\", !\"0.0\", !\"a\", !0, !1 }"},
    {"prog":"{ print !$1, !$2, !$3, !$4 }","input":"0 0.0 a \n"},
    {"prog":"BEGIN { print (\"abc\" < \"abd\"), (\"B\" < \"a\"), (\"a\" < \"B\"), (2 < 10), (\"2\" < \"10\"), (1 == 1.0), (\"1\" == 1), (\"1.0\" == 1), (1 == \"1.0\") }"},
    {"prog":"{ print (u == $1), (u == $2), (u < $1), ($1 == $2), ($1 < $2), ($3 == $4), ($3 < $4) }","input":"abc 0 10abc 10\n"},
    {"prog":"BEGIN { print \"3x\" + 1, \" 4 \" + 1, \"1e2\" + 0, \".5\" + 0, \"abc\" + 0, \"0x10\" + 0, \"+5\" + 0, \"-\" + 0, \"1e\" + 0, \"1e+\" + 0, \".e1\" + 0, \"1.\" + 0, \"+.5\" + 0, \"- 1\" + 0, \"\\t\\n 7\" + 0, \"1_000\" + 0 }"},
    {"prog":"BEGIN { print 2 + 3 * 4, (2 + 3) * 4, 2 ^ 3 ^ 2, -2 ^ 2, 2 ** 3, 2 ^ -1, 7 % 3, -7 % 3, 5.5 % 2, 8 / 2 / 2, 2 ^ 0.5 ^ 2, 5 % -3, 5.5 % 2.5, -7 % 2.5 }"},
    {"prog":"BEGIN { x = 5; print x \" \" x++ \" \" x, ++x, x--, --x; y = 10; y += 5; y -= 3; y *= 2; y /= 4; y %= 4; y ^= 3; print y; a = b = 7; print a, b; z **= 2; print z }"},
    {"prog":"{ $1++; ++$2; print; i = 1; print $i++, i, $i; print -$1, !$1, $1^2 }","input":"5 7\n"},
    {"prog":"BEGIN { x = 1; x++ + ++x; print x; y = 2; print y++ + y++, y; print -x^2, (-x)^2, 2^3^2, (2^3)^2 }"},
    {"prog":"BEGIN { print 1 \" \" 2, 1 \" \"2, 1\" \"2 \"x\"; x = \"a\" \"b\" \"c\"; print x; print \"a\" 1 + 2 \"b\"; print 1 2 * 3; print (1 2) * 3 }"},
    {"prog":"BEGIN { print -\"3abc\", +\"4x\", !\"\", -\"\", 1 - 1 - 1, 2 * 3 % 4, 7 % 4 * 2, !1 + 1 }"},
    {"prog":"BEGIN { a = 5; b = 3; print a -b, a - b, a \" \" -b, a\" \"-b, a \"\" -b }"},
    {"prog":"BEGIN { x = 5; print x == 5 ? \"five\" : \"other\"; print (x > 3) ? \"gt\" : \"le\"; y = x > 3 ? 1 : 0; print y; print x < 3 ? \"a\" : x < 10 ? \"b\" : \"c\" }"},
    {"prog":"BEGIN { print 1 ? \"a\" : \"b\", 0 ? \"a\" : \"b\", (1 && 0), (1 || 0), (\"\" || \"x\"), 2 && \"\", 1 < 2 ? \"y\" : \"n\", \"\" && 1, \"0\" && 1, 0 || \"0\" }"},
    {"prog":"BEGIN { x = \"3.0\"; y = 3; print (x == y), (x + 0 == y), (x \"\" == y \"\"), x + 0, x }"},
    {"prog":"{ x = $1; y = x; print (y < 9), ((z = $1) < 9), (toupper($1) < 9), (substr($1, 1) < 9), ($1 \"\" < 9), (sprintf(\"%d\", $1) < 9), (x + 0 < 9) }","input":"10\n"},
    {"prog":"BEGIN { split(\"10\", p); print (p[1] < 9); a[\"10\"]; for (k in a) print (k < 9), k + 1 }"},
    {"prog":"BEGIN { print (x < 9), (x == \"10\"), (x == 10.0), x + 1 }","args":["-v","x=10"]},
    {"prog":"BEGIN { print (ARGV[1] < 9), ARGV[1] + 1 }","operands":["10"]},
    {"prog":"BEGIN { print length(x), x + 0, \"[\" x \"]\" }","args":["-v","x=a\\tb\\nc\\\"d\\\\e\\101\\x41\\/"]},
    {"prog":"{ print y, $0 }","operands":["y=1","in.txt","y=2","in.txt"],"input":"x\ny\n"},
    {"prog":"{ print (y < 9) }","operands":["y=10","in.txt"],"input":"x\n"},
    {"prog":"BEGIN { print n + 0, n, (n == 10), (n == \"010\"), (n < 9) }","args":["-v","n=010"]},
    {"prog":"BEGIN { x = 0.1; y = x \"\"; print (x == y), y; a[0.5]; for (k in a) print k }"},
    {"prog":"BEGIN { x = 17.0; a[x] = 1; a[\"17\"] = 2; print length(a); y = 0.30000000000000004; a[y]; print length(a); a[1e6]; a[0.1+0.2]; a[1e300]; a[3.0]; a[\"3\"]; a[01]; a[\"01\"]; print length(a) }"},
    {"prog":"BEGIN { CONVFMT = \"%d\"; a[1.7] = 1; for (k in a) print k; x = 1.7; print x \"\", x }"},
    {"prog":"BEGIN { CONVFMT = \"%.2f\"; a[3] = 1; a[3.0] = 2; a[1e300] = 3; a[2.5] = 4; for (k in a) print k, a[k] }","expect":"sorted"},
    {"prog":"BEGIN { print length(12.50), length(1e6), length(0.1 + 0.2), length(1e300), length(-0), length(u) }"},
    {"prog":"BEGIN { print toupper(123), tolower(\"MiXeD\"), toupper(1E2), tolower(0.5), toupper(u) \"|\" }"},
    {"prog":"BEGIN { print 1 == 1, 2 < 3, \"a\" != \"b\", 1 == 1.0, \"a\" == \"a\" }"},
    {"prog":"BEGIN { print 1 in a, (1 in a) \"\", !(1 in a) }"},
    {"prog":"BEGIN { print index(\"abc\", \"bc\"), index(\"\", \"a\"), index(\"aaa\", \"aa\"), index(\"abc\", \"\"), index(\"\", \"\"), index(12345, 34), index(\"a.b\", \".\") }"},
    {"prog":"BEGIN { print substr(\"hello\", 1.5, 2) \"|\" substr(\"hello\", 2.5) \"|\" substr(\"hello\", 1, 2.5) \"|\" substr(\"hello\", 0, 3) \"|\" substr(\"hello\", -1, 3) \"|\" substr(\"hello\", 1.4, 2.6) \"|\" substr(\"hello\", 2, -1) \"|\" substr(\"hello\", \"abc\") \"|\" substr(\"hello\", 2, \"x\") \"|\" substr(\"hello\", 6) \"|\" substr(\"hello\", 2, 1e300) \"|\" substr(\"hello\", -1e300, 3) \"|\" substr(\"hello\", 1e300) \"|\" substr(12345, 2, 2) \"|\" substr(\"\", 1) \"|\" substr(\"hello\", 1.9, 2.9) }"},
    {"prog":"BEGIN { print int(3.9), int(-3.9), int(\"4.5abc\"), int(1e300), int(\"1e3x\"), int(-0.5), int(\"inf\"), int(\"\"), sqrt(16), exp(0), log(1), sin(0), cos(0), atan2(0, 1), atan2(1, 0) }"},
    {"prog":"BEGIN { x = 1e308 * 10; print x, -x, x - x, (x == x), (x - x == x - x) }"},
  ],
  strings: [
    {"prog":"BEGIN { print length, length($1), length(\"\"), length(12345); print length $1 }","input":"abcd ef\n"},
    {"prog":"{ print length, length($1), length(\"\"), length(12345); print length $1 }","input":"abcd ef\n"},
    {"prog":"BEGIN { n = split(\"2024-01-15\", d, \"-\"); print n, d[1], d[3] + 0; print split(\"  a  b \", w), w[1] w[2]; print split(\"a1b2c\", p, /[0-9]/), p[3]; print split(\"\", e), length(e); print split(\"abc\", ch, \"\"), ch[2] }"},
    {"prog":"BEGIN { print split(\"a|b|c\", p, \"|\"), split(\"a.b.c\", q, \".\"), split(\"a b\", r, \"[ ]\"), split(\"aXbXc\", s, /X/), split(\"abc\", t, \"\"), split(\" a\\tb\\nc \", v), v[3] }"},
    {"prog":"BEGIN { n = split(\"abc\", p, /x*/); print n, \"[\" p[1] \"]\"; n = split(\"abc\", q, /b*/); print n, \"[\" q[1] \"][\" q[2] \"]\"; n = split(\"a\", z, \"a\"); print n, \"[\" z[1] \"][\" z[2] \"]\" }"},
    {"prog":"BEGIN { s = \"aaa\"; print sub(/a/, \"b\", s), s; print gsub(/a/, \"&&\", s), s; print gsub(/z/, \"-\", s), s }"},
    {"prog":"{ n = gsub(/o/, \"[&]\"); print n, $0; sub(/l+/, \"\\\\&\"); print; gsub(/x*/, \"-\"); print }","input":"hello world\n"},
    {"prog":"BEGIN { s = \"abc\"; gsub(/x*/, \"-\", s); print s; s = \"abc\"; gsub(/b*/, \"-\", s); print s; s = \"aaa\"; gsub(/a*/, \"-\", s); print s; s = \"abc\"; gsub(/$/, \"!\", s); print s; s = \"abc\"; gsub(/^/, \">\", s); print s; s = \"x\"; gsub(\"\", \"-\", s); print s }"},
    {"prog":"BEGIN { u = \"a.b.c\"; gsub(\".\", \"-\", u); v = \"a.b.c\"; gsub(/\\./, \"-\", v); w = \"a.b.c\"; gsub(\"\\\\.\", \"-\", w); print u, v, w }"},
    {"prog":"BEGIN { s = \"abc\"; sub(/b/, \"[\\\\\\\\&]\", s); print s; s = \"abc\"; sub(/b/, \"\\\\\\\\\\\\\\\\\", s); print s; s = \"abc\"; gsub(/b/, \"\\\\q\", s); print s; s = \"abc\"; gsub(/b/, \"\\\\&&\", s); print s }"},
    {"prog":"{ gsub(/:/, \" \"); print NF, $2 }","input":"a:b\n"},
    {"prog":"{ n = sub(/:/, \"-\", $1); print n, $0, NF }","input":"a:b c\n"},
    {"prog":"BEGIN { print gensub(/(a)(b)/, \"<\\\\2\\\\1>\", \"g\", \"abab ab\"), gensub(/b/, \"X\", 2, \"abab\"), gensub(/(a)(b)?/, \"[\\\\1|\\\\2]\", \"g\", \"ab a\"), gensub(/b/, \"<\\\\0&>\", 1, \"abc\"), gensub(/(b)/, \"<\\\\\\\\1>\", \"g\", \"abc\") }"},
    {"prog":"{ print gensub(/o/, \"0\", \"g\"), gensub(/o/, \"0\", 2), $0 }","input":"foo boo\n"},
    {"prog":"BEGIN { print match(\"foobar\", /o+b/), RSTART, RLENGTH; print match(\"x\", /z/), RSTART, RLENGTH; print match(\"abc\", /d*/), RSTART, RLENGTH; print match(\"aXbXc\", \"X\"), RSTART; print match(\"\", //), RSTART, RLENGTH }"},
    {"prog":"BEGIN { if (match(\"key=value\", /([a-z]+)=([a-z]+)/, g)) print g[0], g[1], g[2], g[2, \"start\"], g[2, \"length\"], length(g) }"},
    {"prog":"BEGIN { match(\"foo=bar\", /(f)(o+)=(b?)(x)?/, m); print m[0], m[1], m[2], \"[\" m[3] \"]\", (4 in m), m[2,\"start\"], m[2,\"length\"] }"},
    {"prog":"BEGIN { print match(\"abcd\", /ab|abcd/), RLENGTH; s = \"ab\"; sub(/a|ab/, \"X\", s); print s; print match(\"aab\", /(a*)(ab)?/), RLENGTH; print match(\"abc\", /(ab)?(abc)?/), RLENGTH; n = split(\"xaby\", p, /a|ab/); print n, p[2] }"},
    {"prog":"BEGIN { s = \"xyz\"; print match(s, /y*/), RSTART, RLENGTH; print match(s, /q|y/), RSTART, RLENGTH; print match(\"aaa\", /a{2}/), RLENGTH; print match(\"ab\", /a?b?c?/), RLENGTH }"},
    {"prog":"BEGIN { print toupper(\"héllo\"), tolower(\"MiXeD\"), sprintf(\"%03d-%s\", 7, \"x\"), sprintf(\"%s\", 1e6), sprintf(\"%d\", \"0x1A\"), sprintf(\"%5.1f|%-3d|\", 2.25, 7) }","expect":"locale"},
    {"prog":"BEGIN { s = sprintf(\"%c%c%c\", 72, 105, 33); print s, length(s) }"},
    {"prog":"BEGIN { print substr(\"hello\", 2, 3) \"|\" substr(\"hello\", 2) \"|\" substr(\"hello\", 4, 100) \"|\" substr(12345, 2, 2) }"},
    {"prog":"BEGIN { print length(\"a\") length(\"bb\"); print length \"x\" }"},
    {"prog":"BEGIN { x = \"abc\"; print x < \"abd\", x > \"ab\", \"B\" < \"a\", 2 < 10, \"2\" < \"10\", 2 < \"10\" }"},
    {"prog":"BEGIN { print \"a\" > \"/dev/stdout\"; print \"b\" >> \"/dev/stdout\"; print \"c\" > \"/dev/null\"; print \"d\" }"},
    {"prog":"BEGIN { s = \"a,b,c\"; n = split(s, arr, \",\"); for (i = n; i > 0; i--) printf \"%s%s\", arr[i], (i > 1 ? \",\" : \"\\n\") }"},
    {"prog":"BEGIN { print index(\"foobar\", \"bar\"), index(\"foobar\", \"baz\") }"},
  ],
  control: [
    {"prog":"!seen[$0]++","input":"x\ny\ny\nz\n"},
    {"prog":"{ c[$3]++ } END { for (k in c) print k, c[k] | \"sort\" }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n","expect":"reject"},
    {"prog":"{ c[$3]++ } END { n = 0; for (k in c) n++; print n, c[\"la\"], c[\"ny\"] }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"{ sum[$3] += $2 } END { print sum[\"la\"], sum[\"ny\"], sum[\"zz\"] + 0 }","input":"ann 25 la\nbob 30 ny\ncid 35 la\n"},
    {"prog":"BEGIN { a[\"x\"] = 1; a[\"y\"] = 2; delete a[\"x\"]; print (\"x\" in a), (\"y\" in a), length(a); delete a; print length(a); delete a[\"q\"]; print length(a) }"},
    {"prog":"BEGIN { if (a[\"x\"] == \"\") print length(a); if (\"y\" in a) print \"no\"; print length(a); if (\"x\" in b) ; print length(b) }"},
    {"prog":"BEGIN { b[1, \"x\"] = 5; print ((1, \"x\") in b); for (k in b) { split(k, p, SUBSEP); print p[1], p[2], length(k) } SUBSEP = \":\"; c[1, 2]; for (k in c) print k }"},
    {"prog":"BEGIN { for (i = 1; i <= 4; i++) a[i]; for (k in a) { delete a[k + 1]; n++ } print n, length(a) }"},
    {"prog":"BEGIN { x = 5; if (x < 3) print \"low\"; else if (x < 10) print \"mid\"; else print \"high\" }"},
    {"prog":"BEGIN { i = 0; do { i++ } while (i < 3); print i; while (i < 10) { i++; if (i == 5) continue; if (i == 8) break; s = s i } print s; for (j = 0; j < 3; j++) t = t j; print t; for (;;) { k++; if (k > 2) break } print k }"},
    {"prog":"BEGIN { for (i = 0; i < 3; i++) ; print i; if (0) ; else print \"else\"; ; { { print \"nested\" } } }"},
    {"prog":"BEGIN { x = 1\nif (x)\n  print \"yes\"\nelse\n  print \"no\"\nfor (i = 0; i < 2; i++)\n  print i\n}"},
    {"prog":"BEGIN { print \"a\" \\\n \"b\" # comment\n# comment line\nprint \"c\" }"},
    {"prog":"BEGIN { do\nprint \"x\"\nwhile (0) }"},
    {"prog":"BEGIN { if (1) print \"a\"; else print \"b\" }"},
    {"prog":"BEGIN { if (1) { print \"a\" }\nelse { print \"b\" } }"},
    {"prog":"NR == 1 { next } { print }","input":"x\ny\n"},
    {"prog":"FNR == 2 { nextfile } { print FILENAME, $0 }","files":{"a.txt":"x\ny\n","b.txt":"y\nz\n"},"operands":["a.txt","b.txt"]},
    {"prog":"BEGIN { print \"b\"; exit 3 } { print \"main\" } END { print \"end\" }","input":"x\ny\n"},
    {"prog":"{ exit 4 } END { print \"e\"; exit }","input":"x\ny\n"},
    {"prog":"NR == 1 { print; exit } END { print \"end\", NR }","input":"x\ny\ny\nz\n"},
    {"prog":"BEGIN { exit -1 }"},
    {"prog":"BEGIN { exit \"3abc\" }"},
    {"prog":"BEGIN { exit 258 }"},
    {"prog":"BEGIN { exit 3.9 }"},
    {"prog":"END { print 1; exit } END { print 2 }","input":"x\ny\n"},
    {"prog":"function f(a, b,   loc) { loc = a + b; g[1] = \"set\"; return loc * 2 } BEGIN { print f(1, 2), g[1], fact(5) } function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) }"},
    {"prog":"function fill(arr) { arr[\"k\"] = \"v\" } function outer(a) { inner(a) } function inner(b) { b[\"x\"] = 1 } BEGIN { fill(m); outer(n); print m[\"k\"], length(n), n[\"x\"] }"},
    {"prog":"function f(a) { a = 5; return a } function g() { return } BEGIN { print f(u), \"[\" u \"]\", \"[\" g() \"]\", g() + 0 }"},
    {"prog":"function clear(arr,  k) { for (k in arr) delete arr[k] } BEGIN { z[1]; z[2]; clear(z); print length(z) }"},
    {"prog":"function twice(x) { return x x } BEGIN { print twice (\"ab\") }"},
    {"prog":"function die(msg) { print msg > \"/dev/stderr\"; exit 7 } function skip() { next } /x/ { skip() } NR == 3 { die(\"boom\") } { print }","input":"x\ny\ny\nz\n"},
    {"prog":"function f(a, i) { a[i] = i; if (i < 3) f(a, i + 1) } BEGIN { f(arr, 1); print length(arr) }"},
    {"prog":"function f(a) { return length(a) } BEGIN { print f(\"abc\"), f(u2) }"},
    {"prog":"function n(arr,  k, c) { for (k in arr) c++; return c } BEGIN { z[1]; z[2]; print n(z), length(z) }"},
    {"prog":"function f() { next } BEGIN { f() }","note":"next in BEGIN via function"},
    {"prog":"function f() { next } END { f() }","input":"x\ny\n"},
    {"prog":"BEGIN { x = 1; { x = 2; { print x } } }"},
    {"prog":"BEGIN { ; ; print \"a\"; ; }"},
    {"prog":";;BEGIN { print 1 };;"},
    {"prog":"BEGIN { while (0) ; do ; while (0); for (;0;) ; print \"ok\" }"},
    {"prog":"BEGIN { for (;;) { if (++i > 3) break }; print i }"},
    {"prog":"BEGIN { do print \"once\"; while (0) }"},
    {"prog":"# only a comment"},
    {"prog":""},
    {"prog":"","input":"x\ny\n"},
    {"prog":"BEGIN { }","input":"x\ny\n"},
    {"prog":"BEGIN { a[\"k\"] = 1; for (k in a) { a[\"new\"] = 2 }; n = 0; for (k in a) n++; print n }"},
    {"prog":"BEGIN { for (i = 1; i <= 3; i++) a[i] = i * i; for (k in a) s += a[k]; print s; print (2 in a), (\"2\" in a), (4 in a), 2.0 in a }"},
    {"prog":"BEGIN { a[1,\"x\"] = 5; for (k in a) { split(k, parts, SUBSEP); print parts[1], parts[2], length(k) } }"},
  ],
  io: [
    {"prog":"NR == 1 { getline; print \"got\", $0, NR } NR == 3 { getline x; print \"x=\" x, NR, $0 } END { print NR }","input":"1\n2\n3\n4\n"},
    {"prog":"BEGIN { while ((getline line < \"a.txt\") > 0) print \"L:\" line; print (getline line < \"nope\"), NR }","files":{"a.txt":"x\ny\n"}},
    {"prog":"BEGIN { f = \"a.txt\"; getline a < f; getline b < f; print (getline c < f); close(f); getline c < f; print a, b, c, close(f), close(\"never\") }","files":{"a.txt":"x\ny\n"}},
    {"prog":"BEGIN { getline < \"people.txt\"; print NF, $2, NR; print ($1 < 9) }","files":{"people.txt":"ann 25 la\nbob 30 ny\ncid 35 la\n"}},
    {"prog":"BEGIN { getline; print \"first:\", $0 } { print \"rest:\", $0 }","input":"x\ny\n"},
    {"prog":"BEGIN { getline line; print NF, \"[\" $0 \"]\", line }","input":"x y\n"},
    {"prog":"NR == 1 { getline x; print NF, NR, x }","input":"1 2 3\n4\n"},
    {"prog":"BEGIN { FS = \":\"; getline; print NF }","input":"a:b\n"},
    {"prog":"BEGIN { FS = \":\"; getline < \"in.txt\"; print NF, $2 }","input":"a:b\n","operands":[]},
    {"prog":"BEGIN { RS = \"\"; getline < \"in.txt\"; print \"[\" $0 \"]\" }","input":"one\n\n  \nfour\n","operands":[]},
    {"prog":"END { print $0, NF; print (getline), $0 }","input":"1\n2\n"},
    {"prog":"{ print $0; while ((getline nxt) > 0) print \"  +\" nxt }","input":"x\ny\n"},
    {"prog":"BEGIN { print (getline x < \"/nonexist\"), ERRNO }"},
    {"prog":"BEGIN { print close(\"x\"), \"[\" ERRNO \"]\"; getline y < \"/nonexist\"; print \"[\" ERRNO \"]\"; getline z < \"a.txt\"; print \"[\" ERRNO \"]\" }","files":{"a.txt":"x\ny\n"}},
    {"prog":"NR == FNR { a[$0]; next } $0 in a { print FILENAME, $0 }","files":{"a.txt":"x\ny\n","b.txt":"y\nz\n"},"operands":["a.txt","b.txt"]},
    {"prog":"FNR == 1 { print FILENAME, NR, FNR } END { print NR, FILENAME }","files":{"a.txt":"x\ny\n","b.txt":"y\nz\n"},"operands":["a.txt","b.txt"]},
    {"prog":"{ print FILENAME \":\" $0 }","input":"x\ny\n","stdin":true},
    {"prog":"{ print FILENAME \":\" $0 }","input":"x\ny\n","stdin":true,"operands":["-"]},
    {"prog":"{ print FILENAME \":\" $0 }","input":"x\ny\n","stdin":true,"files":{"b.txt":"y\nz\n"},"operands":["-","b.txt"]},
    {"prog":"BEGIN { print \"[\" FILENAME \"]\" } END { print \"[\" FILENAME \"]\", NR }","input":"","stdin":true},
    {"prog":"BEGIN { print ARGC; for (i = 1; i < ARGC; i++) print i, ARGV[i] }","files":{"a.txt":"x\ny\n"},"operands":["a.txt","x=1","b.txt"]},
    {"prog":"BEGIN { ARGV[1] = \"b.txt\" } { print }","files":{"a.txt":"x\ny\n","b.txt":"y\nz\n"},"operands":["a.txt"]},
    {"prog":"BEGIN { ARGV[2] = \"b.txt\"; ARGC = 3 } { print }","files":{"a.txt":"x\ny\n","b.txt":"y\nz\n"},"operands":["a.txt"]},
    {"prog":"BEGIN { ARGV[1] = \"\" } { print \"never\" } END { print NR }","files":{"a.txt":"x\ny\n"},"operands":["a.txt"],"input":"","stdin":true},
    {"prog":"{ print $1 }","files":{"a.txt":"x\ny\n","b.txt":"y\nz\n"},"operands":["a.txt","nope","b.txt"]},
    {"prog":"BEGIN { print \"x\" } { print }","operands":["nope"]},
    {"prog":"{ print }","files":{"d/x.txt":"hi\n","a.txt":"x\ny\n"},"operands":["d","a.txt"]},
    {"prog":"{ print v }","input":"q\n","stdin":true,"files":{"a.txt":"x\ny\n"},"operands":["v=1","-","v=2","a.txt"]},
    {"prog":"{ print x }","files":{"a.txt":"x\ny\n"},"operands":["x=a\\qb","a.txt"]},
    {"prog":"BEGIN { print x }","args":["-v","x=a\\nb"]},
    {"prog":"BEGIN { printf \"%s|%s\\n\", ENVIRON[\"NOPE\"], length(ENVIRON[\"NOPE\"]) }"},
    {"prog":"{ print tag, $0 }","files":{"a.txt":"x\ny\n","b.txt":"y\nz\n"},"operands":["tag=A","a.txt","tag=B","b.txt"]},
    {"prog":"{ print }","files":{"a.txt":"x\ny\n"},"args":["-v","OFS=,"],"operands":["a.txt","FS=:"]},
    {"prog":"{ $1 = $1; print }","args":["-v","FS=:","-v","OFS=-"],"input":"a:b\n"},
    {"prog":"{ print RT \"|\" }","input":"a\nb"},
    {"prog":"BEGIN { RS = \"[0-9]+\" } { print \"[\" RT \"]\" }","input":"a1b22c"},
    {"prog":"BEGIN { RS = \"\" } { print \"[\" RT \"]\" }","input":"a\n\n\nb\n"},
    {"prog":"BEGIN { RS = \";\" } { print \"[\" RT \"]\" }","input":"a;b"},
    {"prog":"NR == 2 { NR = 10 } { print NR, FNR }","input":"a\nb\nc\n"},
  ],
  regex: [
    {"prog":"BEGIN { print (\"abc\" ~ /^a.c$/), (\"abc\" !~ /x/), (\"a+b\" ~ /a\\+b/), (\"a+b\" ~ \"a\\\\+b\"), (\"a/b\" ~ /a\\/b/), (\"aa\" ~ /a{2}/), (\"a{2}\" ~ /a{2}/) }"},
    {"prog":"BEGIN { print (\"5\" ~ /^[[:digit:]]+$/), (\"x\" ~ /[[:alpha:][:digit:]]/), (\" \" ~ /[[:space:]]/), (\"a\" ~ /[^[:digit:]]/), (\"a]\" ~ /[]a]+$/), (\"-\" ~ /[a\\-z]/), (\"{\" ~ /{/), (\"_\" ~ /[[:punct:]]/), (\"\\t\" ~ /[[:blank:]]/), (\"a\" ~ /[[:upper:]]/), (\"f\" ~ /[[:xdigit:]]/) }"},
    {"prog":"BEGIN { print (\"word\" ~ /\\<word\\>/), (\"sword\" ~ /\\<word/), (\"words\" ~ /word\\>/), (\"a b\" ~ /a\\yb/), (\"ab\" ~ /a\\yb/), (\"a b\" ~ /a\\y/), (\"ab\" ~ /a\\Bb/), (\"a b\" ~ /a\\Bb/), (\"tab\\there\" ~ /\\t/) }"},
    {"prog":"BEGIN { print (\"x\" ~ /\\q/), (\"q\" ~ /\\q/), (\"a\" ~ /\\a/), (\"\\t\" ~ /\\t/), (\"A\" ~ /\\101/), (\"A\" ~ /\\x41/), (\"a\\bb\" ~ /a\\bb/), (\"a b\" ~ /a\\b/), (\"5\" ~ /\\d/), (\"d\" ~ /\\d/), (\" \" ~ /\\s/), (\"_\" ~ /\\w/), (\"a\" ~ /\\S/), (\"a b\" ~ /a\\sb/), (\"-\" ~ /\\W/) }"},
    {"prog":"BEGIN { print (\"*a\" ~ /*a/), (\"aaa\" ~ /a**/), (\"\" ~ /(|a)/), (\"x\" ~ /()/), (\"+\" ~ /+/), (\"a{\" ~ /a{/), (\"a{1\" ~ /a{1/), (\"a{,2}\" ~ /a{,2}/), (\"aa\" ~ /^a{,2}$/), (\"aaa\" ~ /^a{,2}$/), (\"a)\" ~ /a)/), (\"]\" ~ /]/), (\"}\" ~ /}/), (\"a|*\" ~ /a|*/) }"},
    {"prog":"BEGIN { print (\".\" ~ /[\\.]/), (\"\\\\\" ~ /[\\.]/), (\"-\" ~ /[a\\-z]/), (\"b\" ~ /[a\\-z]/), (\"]\" ~ /[]a]/), (\"^\" ~ /[\\^a]/), (\"b\" ~ /[^]a]/), (\"\\\\\" ~ /[\\\\]/), (\"b\" ~ /[\\]b]/), (\"]\" ~ /[\\]b]/), (\"-\" ~ /[a-]/), (\"-\" ~ /[-a]/), (\"[\" ~ /[[]/) }"},
    {"prog":"BEGIN { print (\"aa\" ~ /(a)\\1/), (\"a1\" ~ /(a)\\1/), (\"a\\001\" ~ /a\\1/) }"},
    {"prog":"{ print ($0 ~ \"\"), ($0 ~ \".\"), match($0, \"\"), RSTART, RLENGTH; n = split($0, p, \".\"); print n; print ($0 ~ 1.5), ($0 ~ $1), (\"1x5\" ~ $1) }","input":"1.5\n"},
    {"prog":"BEGIN { re = \"^[0-9]+$\"; print (\"42\" ~ re), (\"4x\" ~ re); re2 = \"a\\\\.b\"; print (\"a.b\" ~ re2), (\"axb\" ~ re2) }"},
    {"prog":"BEGIN { print (\"a.b\" ~ \"a\\.b\"), (\"axb\" ~ \"a\\.b\") }","note":"unknown escape in string: warning expected both"},
    {"prog":"{ x = /a/; y = /z/; print x, y, /a/ + /b/, !/z/ }","input":"ab\n"},
    {"prog":"BEGIN { print (\"A\" ~ /a/), (\"a\" ~ /A/), (\"ABC\" ~ /^[a-z]+$/) }"},
    {"prog":"BEGIN { IGNORECASE = 1; print (\"A\" ~ /a/), (\"a\" ~ /A/), (\"ABC\" ~ /^[a-z]+$/), (\"A\" == \"a\"), (\"A\" < \"b\"), (\"B\" < \"a\"), index(\"ABC\", \"bc\"), match(\"ABC\", \"b\"), (\"abc\" ~ \"B\"); s = \"AbA\"; print gsub(/a/, \"-\", s), s; a[\"A\"]; print (\"a\" in a); n = split(\"aXbxc\", p, \"x\"); print n; n = split(\"aXbxc\", q, /x/); print n; print match(\"xAy\", /a/), RSTART, RLENGTH }"},
    {"prog":"BEGIN { IGNORECASE = 1; FS = \"x\" } { print NF }","input":"aXb\n"},
    {"prog":"BEGIN { IGNORECASE = 1; FS = \"[x]\" } { print NF }","input":"aXb\n"},
    {"prog":"BEGIN { IGNORECASE = 1; RS = \"x\" } END { print NR }","input":"aXbxc"},
    {"prog":"BEGIN { IGNORECASE = 1; RS = \"[x]\" } END { print NR }","input":"aXbxc"},
    {"prog":"{ print NF }","args":["-v","IGNORECASE=1","-F","x"],"input":"aXb\n"},
    {"prog":"/foo/ { print \"ic:\" $0 } { IGNORECASE = 0 }","args":["-v","IGNORECASE=1"],"input":"Foo\nFOO\n"},
    {"prog":"BEGIN { print (\"a\" ~ /a{2,1}/) }","note":"invalid interval: fatal both"},
    {"prog":"BEGIN { print (\"a\" ~ /[b-a]/) }"},
    {"prog":"BEGIN { print (\"a\" ~ /(a/) }"},
    {"prog":"BEGIN { print (\"a\" ~ /[a/) }"},
    {"prog":"BEGIN { print (\"a\" ~ /a{1,2,3}/) }"},
    {"prog":"BEGIN { print (\"a\" ~ /[[:foo:]]/) }"},
    {"prog":"BEGIN { re = \"(\"; print (\"a\" ~ re) }"},
    {"prog":"BEGIN { print (\"aaa\" ~ /a{3}/), (\"aaa\" ~ /^a{2}$/), (\"ab\" ~ /^(a|b){2}$/), (\"aXb\" ~ /a.b/), (\"a\\nb\" ~ /a.b/), (\"ab\" ~ /^ab$/) }"},
    {"prog":"BEGIN { s = \"The Quick\"; print gsub(/[[:upper:]]/, \"<&>\", s), s; t = \"a1b2\"; gsub(/[^0-9]/, \"\", t); print t }"},
  ],
  gawk: [
    {"prog":"BEGIN { x = \"abc\"; switch (x) { case /^a/: print \"re\"; case \"abc\": print \"str\"; break; case 5: print \"five\"; default: print \"def\" } switch (5) { case \"5\": print \"s5\"; break; case 6: print \"n6\" } switch (u) { default: print \"d\" } switch (\"x\") { case \"y\": print \"no\" } print \"after\" }"},
    {"prog":"{ switch ($1) { case 5: print \"num\"; break; case \"6\": print \"str\"; break; default: print \"d\" } switch ($2) { case /b/: print \"rx\"; break; default: print \"d2\" } }","input":"5 abc\n6 x\n7 b\n"},
    {"prog":"BEGIN { for (i = 1; i <= 3; i++) { switch (i) { case 2: continue; default: print i } } }"},
    {"prog":"BEGIN { switch (x) { case \"\": print \"empty\"; break; case 0: print \"zero\" } switch (-1) { case -1: print \"neg\" } }"},
    {"prog":"BEGIN { switch (1) { case 1: print \"a\"; case 2: print \"b\"; default: print \"c\"; case 3: print \"d\" } }"},
    {"prog":"BEGIN { print and(7, 3, 1), or(1, 2, 4), xor(1, 3, 5), lshift(1, 62), rshift(16, 2), compl(5), compl(0), and(5.9, 3), lshift(1, 64), rshift(3, 1) }"},
    {"prog":"BEGIN { print strtonum(\"017\"), strtonum(\"0x\"), strtonum(\"12abc\"), strtonum(\" 0x1f \"), strtonum(\"1e3\"), strtonum(\"0x1G\"), strtonum(17), strtonum(\"08\"), strtonum(\"-0x10\") }"},
    {"prog":"BEGIN { print and(-1, 1) }"},
    {"prog":"BEGIN { print and(1) }"},
    {"prog":"{ x = 1; y = \"s\"; z[1]; print typeof($1), typeof($2), typeof(x), typeof(y), typeof(z), typeof(w), typeof(1 \"\"), typeof(1 + \"1\"), typeof(NF), typeof(FS) }","input":"10 abc\n"},
    {"prog":"BEGIN { a[1]; print isarray(a), isarray(b), isarray(c[1]) }"},
    {"prog":"BEGIN { FIELDWIDTHS = \"2 3:2 *\" } { print NF; for (i = 1; i <= NF; i++) print \"[\" $i \"]\" }","input":"abcdefghij\n"},
    {"prog":"BEGIN { FIELDWIDTHS = \"1 3 2\" } { print NF, \"[\" $2 \"]\" \"[\" $3 \"]\"; $1 = \"Z\"; print }","input":"ab\n"},
    {"prog":"BEGIN { FIELDWIDTHS = \"1 1\"; FS = \" \" } { print NF, PROCINFO[\"FS\"] }","input":"a b\n"},
    {"prog":"BEGIN { FIELDWIDTHS = \"1 1\" } { print PROCINFO[\"FS\"], NF; FS = \" \"; print PROCINFO[\"FS\"] }","input":"a b\n"},
    {"prog":"BEGIN { FPAT = \"([^,]+)|(\\\"[^\\\"]+\\\")\" } { print NF; for (i = 1; i <= NF; i++) print \"[\" $i \"]\" }","input":"a,\"b,c\",d\n"},
    {"prog":"BEGIN { FPAT = \"x*\" } { print NF, \"[\" $1 \"]\" }","input":"abc\n"},
    {"prog":"BEGIN { FPAT = \"[a-z]+\" } { print NF, $2 }","input":"ab12cd\n"},
    {"prog":"BEGIN { IGNORECASE = 1; FPAT = \"[a-z]\" } { print NF }","input":"AxB\n"},
    {"prog":"BEGINFILE { print \"bf\", FILENAME, FNR, NR } ENDFILE { print \"ef\", FILENAME, FNR } { print }","files":{"a.txt":"x\ny\n","b.txt":"y\nz\n"},"operands":["a.txt","b.txt"]},
    {"prog":"BEGINFILE { if (ERRNO) { print \"skip\", FILENAME, ERRNO; nextfile } print \"open\", FILENAME } { print } ENDFILE { print \"end\", FILENAME, FNR }","files":{"a.txt":"x\ny\n","b.txt":"y\nz\n"},"operands":["a.txt","nope","b.txt"]},
    {"prog":"BEGINFILE { print \"bf\" } { print }","operands":["nope"]},
    {"prog":"BEGINFILE { print \"bf\", \"[\" ERRNO \"]\" } { print }","files":{"d/x":"q\n","a.txt":"x\ny\n"},"operands":["d","a.txt"]},
    {"prog":"BEGINFILE { nextfile } ENDFILE { print \"ef\", FILENAME } END { print NR }","files":{"a.txt":"x\ny\n","b.txt":"y\nz\n"},"operands":["a.txt","b.txt"]},
    {"prog":"FNR == 1 { nextfile } ENDFILE { print \"ef\", FILENAME, FNR, NR }","files":{"a.txt":"x\ny\n","b.txt":"y\nz\n"},"operands":["a.txt","b.txt"]},
    {"prog":"{ exit } ENDFILE { print \"ef\" } END { print \"end\" }","input":"x\ny\n"},
    {"prog":"ENDFILE { exit 4 } END { print \"end\" }","files":{"a.txt":"x\ny\n","b.txt":"y\nz\n"},"operands":["a.txt","b.txt"]},
    {"prog":"BEGINFILE { exit 5 } { print \"never\" } END { print \"end\", NR }","input":"x\ny\n"},
    {"prog":"ENDFILE { print \"ef\", FILENAME, NR }","input":"x\ny\n","stdin":true},
    {"prog":"BEGIN { RT = \"z\"; print RT; print (NF < 9), typeof(RT) }"},
    {"prog":"BEGIN { print PROCINFO[\"FS\"], typeof(PROCINFO) }"},
    {"prog":"BEGIN { print \"[\" ERRNO \"]\", length(ERRNO) }"},
    {"prog":"BEGIN { print length(\"héllo\"), toupper(\"héllo\"), index(\"héllo\", \"l\"), substr(\"héllo\", 2, 2) }","expect":"locale"},
  ],
  errors: [
    {"prog":"BEGIN { print 1 / 0 }"},
    {"prog":"BEGIN { print 1 % 0 }"},
    {"prog":"BEGIN { print \"a\"; print 1 / 0; print \"b\" }"},
    {"prog":"{ print $1 / $2 }","input":"1 0\n2 1\n"},
    {"prog":"BEGIN { x[1] = 1; x = 2 }"},
    {"prog":"BEGIN { x = 2; x[1] = 1 }"},
    {"prog":"BEGIN { x = 2; print length(x), x[1] }"},
    {"prog":"BEGIN { a[1]; delete a; a = 1; print a }"},
    {"prog":"BEGIN { if (1 in q) print \"y\"; q = 1; print q }"},
    {"prog":"BEGIN { NF = -1 }"},
    {"prog":"BEGIN { print $-1 }"},
    {"prog":"BEGIN { print 1<2<3 }"},
    {"prog":"BEGIN { x = 1 == 1 == 1; print x }"},
    {"prog":"BEGIN { print 3 > 2 > 1 }"},
    {"prog":"BEGIN { print \"a\" ~ \"b\" ~ \"c\" }"},
    {"prog":"BEGIN { if (1) print \"a\" else print \"b\" }"},
    {"prog":"BEGIN { if (1) { print \"a\" } ; else print \"b\" }"},
    {"prog":"BEGIN {"},
    {"prog":"BEGIN { print \"abc }"},
    {"prog":"BEGIN { /abc }"},
    {"prog":"BEGIN { print length(\"x\" }"},
    {"prog":"BEGIN { print foo(1) }"},
    {"prog":"BEGIN { break }"},
    {"prog":"BEGIN { return 1 }"},
    {"prog":"BEGIN { next }"},
    {"prog":"END { nextfile }"},
    {"prog":"BEGIN { substr(\"a\") }"},
    {"prog":"BEGIN { sub(/a/, \"b\", \"c\") }","expect":"reject"},
    {"prog":"BEGIN { split(\"a b\", 3) }"},
    {"prog":"BEGIN { x = 1 +* 2 }"},
    {"prog":"BEGIN { print 1,, 2 }"},
    {"prog":"function f(a, a) { }"},
    {"prog":"function length(x) { }"},
    {"prog":"function f() { } function f() { }"},
    {"prog":"BEGIN\n{ print 1 }"},
    {"prog":"BEGIN { print 1e }"},
    {"prog":"BEGIN { print 1.2.3 }"},
    {"prog":"BEGIN { print 1e+ }"},
    {"prog":"BEGIN { printf }"},
    {"prog":"BEGIN { printf \"%s %s\\n\", \"only\" }"},
    {"prog":"BEGIN { print \"x\" > \"out.txt\" }","expect":"reject"},
    {"prog":"BEGIN { print \"x\" >> \"out.txt\" }","expect":"reject"},
    {"prog":"BEGIN { print \"x\" | \"cat\" }","expect":"reject"},
    {"prog":"BEGIN { \"id\" | getline x; print x }","expect":"reject"},
    {"prog":"BEGIN { system(\"true\") }","expect":"reject"},
    {"prog":"BEGIN { print strftime() }","expect":"reject"},
    {"prog":"BEGIN { switch (1) { case 1: print \"a\"; case 1: print \"b\" } }"},
    {"prog":"BEGIN { switch (5) { case 5: print \"a\"; case \"5\": print \"b\" } }"},
    {"prog":"BEGIN { getline x < \"d\" }","files":{"d/x":"q\n"}},
    {"prog":"BEGIN { print substr(\"hello\", 2, 3, 4) }"},
    {"prog":"BEGIN { print length() }"},
    {"prog":"BEGIN { x = \"a\"; y = x | getline }","expect":"reject"},
    {"prog":"BEGIN { delete }"},
    {"prog":"BEGIN { print 08.5, 09, 010.5 }"},
    {"prog":"BEGIN { print (1, 2) }"},
    {"prog":"BEGIN { f = \"a\"; f(1) }"},
    {"prog":"BEGIN { print a[1][2] }","expect":"reject"},
    {"prog":"BEGIN { @include \"x\" }"},
    {"prog":"BEGIN { print $(-1) }"},
    {"prog":"BEGIN { for (k in 5) print k }"},
  ],
}

// --- generated cases ---------------------------------------------------

// mulberry32, seeded, so a run is reproducible.
const TWO_32 = 4294967296
function rng(seed) {
  let a = seed % TWO_32
  return () => {
    a = (a + 0x6D2B79F5) % TWO_32
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    const r = t ^ (t >>> 14)
    return (r < 0 ? r + TWO_32 : r) / TWO_32
  }
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)]

const NUM_LITS = ['0', '1', '2', '3', '10', '9', '0.5', '1.5', '2.5', '1e2', '1e-5', '123456789', '0.1', '(-3)', '1000000', '7']
const STR_LITS = ['""', '"a"', '"b"', '"10"', '"9"', '"abc"', '" 3 "', '"0"', '"1e2"', '"0x10"', '"+5"', '"-0"', '"3.0"', '"inf"', '"+inf"', '"nan"', '"A"', '"ab c"']
const FIELDS = ['$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', '$10', '$0', '$NF', '$(NF+1)']
const VARS = ['u', 'n', 'x', 'y', 'z']
const BIN_OPS = ['+', '-', '*', '/', '%', '^']
const REL_OPS = ['<', '<=', '==', '!=', '>', '>=']

function genExpr(r, depth) {
  if (depth <= 0 || r() < 0.3) {
    const t = r()
    if (t < 0.3) return pick(r, NUM_LITS)
    if (t < 0.55) return pick(r, STR_LITS)
    if (t < 0.8) return pick(r, FIELDS)
    return pick(r, VARS)
  }
  const a = genExpr(r, depth - 1)
  const b = genExpr(r, depth - 1)
  const t = r()
  if (t < 0.25) return `(${a} ${pick(r, BIN_OPS)} ${b})`
  if (t < 0.4) return `(${a} ${pick(r, REL_OPS)} ${b})`
  if (t < 0.5) return `(${a} ${b})`
  if (t < 0.55) return `(-${a})`
  if (t < 0.6) return `(!${a})`
  if (t < 0.65) return `(${a} && ${b})`
  if (t < 0.7) return `(${a} || ${b})`
  if (t < 0.75) return `(${a} ? ${b} : ${genExpr(r, depth - 1)})`
  if (t < 0.8) return `length(${a})`
  if (t < 0.84) return `substr(${a}, ${b})`
  if (t < 0.87) return `index(${a}, ${b})`
  if (t < 0.9) return `int(${a})`
  if (t < 0.93) return `sprintf("${pick(r, ['%d', '%s', '%.2f', '%5.1e', '%x', '%g', '%i', '%o', '%3s', '%-4d|'])}", ${a})`
  if (t < 0.96) return `toupper(${a})`
  return `(${a} ~ ${pick(r, ['"a"', '"1"', '"."', '"^1"', '/[0-9]/', '/^$/', '/a|b/', '"0"'])})`
}

// Expressions without parentheses around binary operators, to exercise
// precedence and the lexer (concatenation, unary minus, `/` vs regex).
function genFlat(r, n) {
  const parts = []
  for (let i = 0; i < n; i++) {
    const t = r()
    parts.push(t < 0.4 ? pick(r, NUM_LITS) : t < 0.7 ? pick(r, STR_LITS) : t < 0.9 ? pick(r, FIELDS) : pick(r, VARS))
    if (i < n - 1) parts.push(pick(r, ['+', '-', '*', '/', '%', '^', '', ' ', '<', '==', '!=', '&&', '||', '>=']))
  }
  return parts.join(' ')
}

function exprCases(count, seed) {
  const r = rng(seed)
  const cases = []
  for (let c = 0; c < count; c++) {
    const lines = []
    for (let i = 0; i < 25; i++) lines.push(`print (${genExpr(r, 3)})`)
    for (let i = 0; i < 10; i++) lines.push(`print (${genFlat(r, 2 + Math.floor(r() * 4))})`)
    cases.push({ prog: `{ n = 5; x = "10"; y = $1; z = "abc"\n${lines.join('\n')}\n}`, input: NUMS })
  }
  return cases
}

// Regexes over {a, b, c}; no anchors — an anchored pattern that matches
// the empty string trips a gawk quirk in split() (it drops the first
// character), which is not behavior to reproduce.
function genRegex(r, depth) {
  const pieces = []
  const n = 1 + Math.floor(r() * 3)
  for (let i = 0; i < n; i++) {
    const t = r()
    let atom
    if (t < 0.45) atom = pick(r, ['a', 'b', 'c'])
    else if (t < 0.55) atom = '.'
    else if (t < 0.65) atom = pick(r, ['[ab]', '[^a]', '[a-c]', '[bc]'])
    else if (t < 0.85 && depth > 0) atom = `(${genRegex(r, depth - 1)})`
    else atom = pick(r, ['a', 'b', 'c'])
    const q = r()
    if (q < 0.15) atom += '*'
    else if (q < 0.25) atom += '+'
    else if (q < 0.35) atom += '?'
    else if (q < 0.4) atom += pick(r, ['{1,2}', '{2}', '{0,1}', '{1,}'])
    pieces.push(atom)
  }
  let re = pieces.join('')
  if (r() < 0.3) re += '|' + genRegex(r, depth - 1)
  return re
}

function genSubject(r) {
  const len = Math.floor(r() * 8)
  let s = ''
  for (let i = 0; i < len; i++) s += pick(r, ['a', 'b', 'c', 'a', 'b'])
  return s
}

function regexCases(count, seed) {
  const r = rng(seed)
  const cases = []
  for (let c = 0; c < count; c++) {
    const lines = []
    for (let i = 0; i < 12; i++) {
      const re = genRegex(r, 2)
      for (let j = 0; j < 4; j++) {
        const s = genSubject(r)
        lines.push(`s = "${s}"; r = "${re}"`)
        lines.push(`print "${re}|${s}|", match(s, /${re}/), RSTART, RLENGTH, (s ~ /${re}/), (s ~ r)`)
        lines.push(`t = s; n = gsub(/${re}/, "<&>", t); print "gsub", n, t`)
        lines.push(`t = s; n = sub(/${re}/, "[&]", t); print "sub", n, t`)
        lines.push(`n = split(s, p, /${re}/); o = n; for (i = 1; i <= n; i++) o = o "|" p[i]; print "split", o`)
        lines.push(`print "gensub2", gensub(/${re}/, "{&}", 2, s)`)
      }
    }
    cases.push({ prog: `BEGIN {\n${lines.join('\n')}\n}` })
  }
  return cases
}

const FMT_ARGS = ['0', '1', '-1', '42', '-42', '3.14159', '-3.14159', '0.5', '2.5', '1e6', '1e-6', '123456789', '0.000123456', '"abc"', '"12abc"', '""', '"3.9"', '$1', '$2', '$3', '65', '1e30', '2^53', '-0', '0.125', '9.995', '99.5', '1.5', '100']

function printfCases(count, seed) {
  const r = rng(seed)
  const cases = []
  for (let c = 0; c < count; c++) {
    const lines = []
    for (let i = 0; i < 30; i++) {
      const flags = ['-', '+', ' ', '0', '#'].filter(() => r() < 0.2).join('')
      const width = r() < 0.5 ? String(Math.floor(r() * 12)) : ''
      const prec = r() < 0.5 ? '.' + (r() < 0.2 ? '' : String(Math.floor(r() * 7))) : ''
      const conv = pick(r, ['d', 'i', 'o', 'u', 'x', 'X', 'e', 'E', 'f', 'F', 'g', 'G', 's', 'c', 'd', 'f', 'g', 's'])
      const arg = conv === 'c' ? pick(r, ['65', '"abc"', '""', '97', '$1', '48']) : pick(r, FMT_ARGS)
      const spec = `%${flags}${width}${prec}${conv}`
      lines.push(`printf "%%${spec.slice(1)} of ${arg.replace(/"/gu, "'")} = [${spec}]\\n", ${arg}`)
    }
    cases.push({ prog: `{\n${lines.join('\n')}\n}`, input: '65 -7.5 abc\n' })
  }
  return cases
}

// FS / RS values and lines with leading, trailing and doubled
// separators. An RS regex that can match the empty string is left out:
// gawk handles that one oddly (empty records), and nobody writes it.
const FS_LIST = [' ', ':', ',', '\\t', '|', '.', '[,;]', ', *', '  ', '', '\\\\|', 'a', '[ ]', ' +', 'x*', '\\\\.', '[.]', '(,)', 'b*', '^a', 'c$', '[[:space:]]+', ';']
const RS_LIST = ['\\n', '', ';', '[;,]', '\\n\\n', 'a', ',+']
const LINES = [':a::b:', '  a  b  ', 'a,b;c', 'a|b|c', 'abc', '', ' ', 'a.b.c', 'a\tb\t\tc', ',a,', 'x', 'aaa', 'a b\tc', '  ', 'a,,b', 'c;a;b']

function fieldCases(count, seed) {
  const r = rng(seed)
  const cases = []
  const prog = '{ printf "%d:", NF; for (i = 1; i <= NF; i++) printf "[%s]", $i; print "" }'
  for (let c = 0; c < count; c++) {
    const fs = pick(r, FS_LIST)
    const input = Array.from({ length: 6 }, () => pick(r, LINES)).join('\n') + (r() < 0.5 ? '\n' : '')
    cases.push({ prog, args: ['-F', fs], input })
    cases.push({ prog: `BEGIN { FS = "${fs}" } ${prog}`, input })
    const rs = pick(r, RS_LIST)
    const rsInput = Array.from({ length: 5 }, () => pick(r, [...LINES, '\n', ';', ',', 'a;b'])).join(pick(r, ['\n', ';', '\n\n', ',', ''])) + pick(r, ['', '\n', ';', '\n\n'])
    cases.push({ prog: `BEGIN { RS = "${rs}" } { printf "%d:[%s]<%s>\\n", NR, $0, RT }`, input: rsInput })
  }
  return cases
}

describe('awk — differential against gawk', { skip: GAWK ? false : 'gawk is not installed' }, () => {
  for (const [name, cases] of Object.entries(SECTIONS)) {
    it(`${name}: ${cases.length} cases agree with gawk`, () => {
      for (const c of cases) check(c)
    })
  }
  it('generated expressions agree with gawk', () => { for (const c of exprCases(6, 21)) check(c) })
  it('generated regex operations agree with gawk', () => { for (const c of regexCases(6, 22)) check(c) })
  it('generated printf formats agree with gawk', () => { for (const c of printfCases(6, 23)) check(c) })
  it('generated field and record splitting agrees with gawk', () => { for (const c of fieldCases(12, 24)) check(c) })
})
