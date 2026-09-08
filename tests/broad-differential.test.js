// Native binaries are test oracles only. Supported cases must match; an
// unsupported diagnostic is a test failure, never a substitute for output.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { after, describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const dir = mkdtempSync(join(tmpdir(), 'terminal-broad-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const env = { ...process.env, LC_ALL: 'C' }
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'"
function reference(name, marker = /GNU|coreutils/u, versionArg = '--version') {
  for (const candidate of [name, 'g' + name]) {
    const r = spawnSync(candidate, [versionArg], { encoding: 'utf8', env })
    if (r.status === 0 && marker.test(r.stdout + r.stderr)) return candidate
  }
  return null
}
function fixture(files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}
function compare(cmd, binary, args, files, input = '', locale = 'C') {
  fixture(files)
  // Keep the pipe open until all input is drained, even when the native
  // command ignores stdin or exits early. Otherwise spawnSync can race
  // with that exit and report EPIPE instead of the command's result.
  const ref = spawnSync('/bin/sh', ['-c', '"$@"; reference_status=$?; cat >/dev/null; exit "$reference_status"', 'reference', binary, ...args], { cwd: dir, env: { ...env, LC_ALL: locale }, input, encoding: 'utf8', timeout: 5000 })
  assert.equal(ref.error, undefined)
  assert.equal(ref.signal, null)
  const source = `cat input | ${cmd} ${args.map(quote).join(' ')}`
  const mine = createTerminal({ ...files, input }).run(source)
  assert.deepEqual(mine.unsupported, [], source)
  assert.deepEqual([mine.stdout, mine.exitCode, Boolean(mine.stderr)], [ref.stdout, ref.status, Boolean(ref.stderr)], source)
}

const MODES = {
  cat: ['', '-n', '-b', '-s', '-E', '-A', '-bsE'],
  head: ['', '-n0', '-n1', '-n-1', '-c0', '-c1', '-c-1', '-qn1', '-vn1'],
  tail: ['', '-n0', '-n1', '-n+1', '-c0', '-c1', '-c+2', '-qn1', '-vn1'],
  wc: ['', '-l', '-w', '-lc', '-cm'],
  sort: ['', '-u', '-n', '-nr', '-k2,2'],
  nl: ['', '-ba', '-bn'],
  cut: ['-c1', '-c1-2', '-f1', '-d: -f2', '-s -d: -f2'],
  tac: [''],
  od: ['', '-v', '-j1', '-N0', '-N1', '-j2 -N3'],
}
for (const [cmd, modes] of Object.entries(MODES)) {
  const binary = reference(cmd)
  describe(`broad native ${cmd} — file boundaries, errors and shared stdin`, { skip: binary ? false : `GNU ${cmd} unavailable` }, () => {
    for (const mode of modes) {
      for (const [f, g] of [['a', 'b\n'], ['a\n', 'b'], ['\n', '\n'], ['', 'b\n'], ['ab\ncd\n', 'ef\ngh\n']]) {
        for (const paths of [['f', 'g'], ['f', 'missing', 'g'], ['f', 'dir', 'g'], ['-', 'f', '-']]) {
          // A seek across a directory has an explicit diagnostic, separately
          // tested; its filesystem-specific semantics are not modeled.
          if (cmd === 'od' && mode.includes('-j') && paths.includes('dir')) continue
          const args = [...mode.split(' ').filter(Boolean), ...paths]
          it(`${args.join(' ')} ${JSON.stringify([f, g])}`, () => compare(cmd, binary, args, { f, g, 'dir/z': '' }, 'pipe\n'))
        }
      }
    }
  })
}

for (const cmd of ['head', 'tail', 'od']) {
  const binary = reference(cmd)
  describe(`broad native ${cmd} — count syntax`, { skip: binary ? false : `GNU ${cmd} unavailable` }, () => {
    const counts = cmd === 'od' ? ['0', '010', '0x10', '+2', '1b', '1K', '1kB', '1KiB', ' 2'] : ['0', '010', '+2', '-2', '++1', '-+1', '1b', '1K', '1kB', '1KiB', 'K', ' 2', '18446744073709551615']
    for (const count of counts) it(count, () => compare(cmd, binary, [cmd === 'od' ? '-N' : '-c', count, 'f'], { f: '0123456789abcdef\n'.repeat(80) }))
  })
}

const cut = reference('cut')
describe('broad native cut — delimiters and position lists', { skip: cut ? false : 'GNU cut unavailable' }, () => {
  for (const delimiter of ['', '\n', ':', 'é']) {
    for (const content of ['', 'a', 'a\n', 'a\nb\n', 'a\0b\n', 'a:b\n']) {
      for (const field of ['1', '2', '1-']) it(JSON.stringify([delimiter, content, field]), () => compare('cut', cut, ['-d', delimiter, '-f', field, 'f'], { f: content }))
    }
  }
  for (const list of ['1 3', '1\t3', '1, 3', '3,1', '1-3,2-4']) it(list, () => compare('cut', cut, ['-c', list, 'f'], { f: 'abcde\n' }))
})

const xargs = reference('xargs')
describe('broad native xargs — argument boundaries', { skip: xargs ? false : 'GNU xargs unavailable' }, () => {
  for (const mode of [[], ['-n1'], ['-n2'], ['-r'], ['-0'], ['-I{}']]) {
    const inputs = ['', 'a b\n', ' a  b\n\n c\t\n', 'a\rb\vc\fd\n', 'a\\', "'' \"\" x\n", 'a\0b\0', '\0\0']
    for (const input of inputs) {
      if (!mode.includes('-0') && input.includes('\0')) continue
      if (mode.includes('-I{}') && /["'\\]/u.test(input)) continue
      it(JSON.stringify([mode, input]), () => compare('xargs', xargs, [...mode, 'echo', 'pre', '{}'], { f: '' }, input))
    }
  }
})

const xxd = reference('xxd', /xxd/u, '-v')
describe('broad native xxd — byte limits and offsets', { skip: xxd ? false : 'xxd unavailable' }, () => {
  for (const args of [[], ['-s1'], ['-l0'], ['-l1'], ['-s2', '-l3'], ['-s010'], ['-l010'], ['-s0x10']]) {
    for (const content of ['', 'a', 'a\n', '0123456789abcdef\n', 'é😀\n']) {
      // Byte-splitting a named input is representable as a hex dump; the
      // untouched standard input has no invalid UTF-8 remainder to expose.
      it(JSON.stringify([args, content]), () => compare('xxd', xxd, [...args, 'f'], { f: content }))
    }
  }
})

const bash = reference('bash', /GNU bash, version (?:5\.[2-9]|[6-9]\.)/u)
describe('broad native Bash — expansion, redirects and control flow', { skip: bash ? false : 'Bash 5.2+ unavailable' }, () => {
  const files = { a: '', 'a.js': '', b: '', 'dir/z': '', f: 'one\ntwo\n', g: 'three\n', '[z-a]': '' }
  const scripts = [
    'echo dir//* ././*.js .//dir///', 'echo [!z-a] [z-a]', 'echo [a-z-x] [x-z-a]',
    "x=' a  b '; echo pre${x}post", "x='*'; echo $x\"\"$x", "echo a{b,c}{1,2} 'a'{b,c}",
    'x=one; (x=two; echo $x); echo $x', 'x=one; x=tmp export x; echo $x',
    'x=one; export x+=two y=three; echo $x $y', 'export x=one bad-name y=two; echo $x $y',
    'x=a; y=b; unset x bad-name y; echo "${x}" "${y}"', 'unset -- -name; echo done',
    'exit " 3 "', 'break 0; echo done', 'for x in a b; do (break); echo $x; done',
    '{ head -c1; cat; } < f', '{ head -n0; cat; } < f', '{ head -n1; cat; } < f',
    '{ xargs -n0; cat; } < f', '{ tr a; cat; } < f', '{ sort missing; cat; } < f',
  ]
  for (const control of ['break', 'continue']) {
    for (const count of ['1', '2', '+2', '3', '0', '-1', 'nope', '1 2']) {
      scripts.push(`for x in a b; do for y in c d; do echo $x$y; ${control} ${count}; echo inner; done; echo outer; done; echo done`)
    }
  }
  for (const body of ['{ echo a >&2; echo b; echo c >&2; }', '(echo a >&2; echo b; echo c >&2)', 'for x in a b c; do echo $x >&2; done']) {
    for (const suffix of ['2>&1', '|& cat', '2>&1 | cat', '2>/dev/null |& cat', '>/dev/null |& cat']) scripts.push(body + ' ' + suffix)
  }
  for (const script of scripts) {
    it(script, () => {
      // A separate directory prevents leftover fixtures from changing globs.
      const cwd = mkdtempSync(join(dir, 'shell-'))
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(cwd, path)), { recursive: true })
        writeFileSync(join(cwd, path), content)
      }
      const ref = spawnSync(bash, ['--noprofile', '--norc', '-c', script], { cwd, env, encoding: 'utf8', timeout: 5000 })
      assert.equal(ref.error, undefined)
      assert.equal(ref.signal, null)
      const mine = createTerminal(files).run(script)
      assert.deepEqual(mine.unsupported, [])
      assert.deepEqual([mine.stdout, mine.exitCode, Boolean(mine.stderr)], [ref.stdout, ref.status, Boolean(ref.stderr)])
    })
  }
})

const NAV_MODES = {
  ls: [[], ['-a'], ['-A'], ['-F'], ['-d'], ['-r'], ['-R'], ['-aRF']],
  tree: [[], ['-a'], ['-d'], ['-F'], ['--noreport'], ['-L', '1'], ['-adL', '2']],
  find: [[], ['-maxdepth', '0'], ['!', '!', '-name', 'a'], ['-name', 'a', '-o', '-name', 'f'], ['-type', 'f'], ['-name', '[!z-a]']],
}
for (const [cmd, modes] of Object.entries(NAV_MODES)) {
  const binary = cmd === 'tree' ? reference(cmd, /tree v2\./u) : reference(cmd)
  describe(`broad native ${cmd} — names and traversal`, { skip: binary ? false : `${cmd} reference unavailable` }, () => {
    for (const mode of modes) {
      for (const root of ['.', 'b', 'f', 'missing']) {
        const args = cmd === 'find' ? [root, ...mode] : [...mode, root]
        it(args.join(' '), () => {
          const files = { '.hidden': '', a: '', 'b/q': '', 'b/z': '', f: '', 'z/.hidden': '', 'z/k': '' }
          const cwd = mkdtempSync(join(dir, 'nav-'))
          for (const [path, content] of Object.entries(files)) {
            mkdirSync(dirname(join(cwd, path)), { recursive: true })
            writeFileSync(join(cwd, path), content)
          }
          const ref = spawnSync(binary, args, { cwd, env: { ...env, LC_ALL: 'en_US.UTF-8' }, encoding: 'utf8', timeout: 5000 })
          assert.equal(ref.error, undefined)
          const mine = createTerminal(files).run(`${cmd} ${args.map(quote).join(' ')}`)
          assert.deepEqual(mine.unsupported, [])
          // find's sibling traversal order is unspecified. Compare the
          // complete record multiset, retaining duplicates and blank records.
          const normalize = (s) => cmd === 'find' ? s.split('\n').sort().join('\n') : s
          assert.deepEqual([normalize(mine.stdout), mine.exitCode, Boolean(mine.stderr)], [normalize(ref.stdout), ref.status, Boolean(ref.stderr)])
        })
      }
    }
  })
}
