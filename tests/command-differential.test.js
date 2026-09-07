// Optional native differential tests. Put GNU coreutils and GNU grep on
// PATH (or their g-prefixed commands). No native commands enter src/.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const dir = mkdtempSync(join(tmpdir(), 'terminal-differential-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const env = { ...process.env, LC_ALL: 'C' }
function reference(name) {
  for (const candidate of [name, 'g' + name]) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', env })
    if (r.status === 0 && /GNU|coreutils/u.test(r.stdout)) return candidate
  }
  return null
}
function compare(command, binary, argv, input, allowUnsupported = true) {
  writeFileSync(join(dir, 'f'), input)
  const fd = openSync(join(dir, 'f'), 'r')
  let ref
  try { ref = spawnSync(binary, argv, { cwd: dir, env, stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000 }) } finally { closeSync(fd) }
  assert.equal(ref.error, undefined, command)
  const mine = createTerminal({ f: input }).run(command)
  if (!allowUnsupported) assert.deepEqual(mine.unsupported, [], command)
  if (mine.unsupported.length) {
    assert.notEqual(mine.exitCode, 0, command)
    assert.notEqual(mine.stderr, '', command)
    const hidden = createTerminal({ f: input }).run(`${command} 2>/dev/null | cat`)
    assert.deepEqual(hidden.unsupported, mine.unsupported, command)
    return
  }
  assert.deepEqual([mine.stdout, mine.exitCode], [ref.stdout, ref.status], `${command}: ${JSON.stringify(input)}`)
}

const specs = {
  cat: ['', '-n', '-b', '-s', '-E', '-T', '-v', '-A', '-bE', '-ns'],
  head: ['', '-n0', '-n1', '-n-1', '-n2', '-c1', '-c-1', '-qv', '-vq'],
  tail: ['', '-n0', '-n1', '-n+2', '-n2', '-c1', '-c-1', '-qv', '-vq'],
  sort: ['', '-n', '-nu', '-b', '-r', '-f', '-k1', '-k2,2', '-u', '-nr'],
  uniq: ['', '-c', '-d', '-u', '-D', '-f1', '-s1', '-w1'],
  cut: ['-c1', '-c2-3', '-f1', '-d: -f2', '-s -d: -f2'],
  tac: [''], nl: ['', '-ba', '-bn'], wc: ['', '-lw', '-lwc', '-l', '-c', '-w'],
  tr: ['a b', '-d a', '-s a', '-c a X', '-c a XY', '-s a b'],
}
const inputs = ['', 'a', 'a\n', 'a\nb', '\n\n\n', 'a\r\nb\n', ' a\tb\n\ta b\n', 'a:a\nb:b\n', 'a\0b\n', '2\n10\n01\n1\n', 'a\va\na\fa\n']

for (const [command, options] of Object.entries(specs)) {
  const binary = reference(command)
  describe(`${command} — native GNU differential`, { skip: binary === null ? `GNU ${command} is not available` : false }, () => {
    for (const option of options) {
      for (const input of inputs) {
        it(`${option || 'default'} on ${JSON.stringify(input)}`, () => {
          compare(`${command} ${option} < f`, binary, option ? option.split(' ') : [], input)
        })
      }
    }
  })
}
const patterns = ['a|ab','a.*','[[:alpha:]]','[a-z]','[]a]','[^]a]','a+','a*?','a\\+','\\d','\\x61','\\bword\\b','\\(a\\)\\1','^a$','a\\{1,2\\}']

const grep = reference('grep')
describe('grep — native GNU regex differential', { skip: grep === null ? 'GNU grep is not available' : false }, () => {
  for (const mode of ['', '-E', '-o', '-Eo', '-w', '-F']) {
    for (const pattern of patterns) {
      it(`${mode || 'BRE'} ${pattern}`, () => {
        compare(`grep ${mode} '${pattern}' f`, grep, [...(mode ? [mode] : []), pattern, 'f'], 'a\nab\naa\n1\nd\nx61\nword\n]a\n')
      })
    }
  }
})

describe('grep — agent search patterns against GNU', { skip: grep === null ? 'GNU grep is not available' : false }, () => {
  const agentPatterns = ['^$', '.', '^.$', '^x.*$', '\\<word\\>', '\\>word\\<', '\\t', '\\n', '\\r', '\\\\b']
  const agentInputs = ['\n', 'x\r\nword!\n!word\n\r\n', 't\nn\nr\n\t\n\\b\n\\y\n']
  for (const mode of ['', '-E', '-o', '-Eo', '-c', '-n', '-r', '-A0']) {
    for (const pattern of agentPatterns) {
      for (const input of agentInputs) {
        it(`${mode || 'BRE'} ${pattern} on ${JSON.stringify(input)}`, () => {
          compare(`grep ${mode} '${pattern}' f`, grep, [...(mode ? [mode] : []), pattern, 'f'], input, false)
        })
      }
    }
  }
})

for (const [command, options] of Object.entries({ sort: ['', '-f', '-fu', '-nr', '-u', '-k1,1f'], uniq: ['', '-i', '-s1', '-s2', '-w1', '-w2', '-iw1'] })) {
  const binary = reference(command)
  describe(`${command} — Unicode comparison against GNU C locale`, { skip: binary === null ? `GNU ${command} is not available` : false }, () => {
    for (const option of options) {
      for (const input of ['ä\nÄ\nß\nSS\nſ\ns\n', 'éx\néy\n', '\uE000\n😀\n', 'é\nê\n😀\n😁\n']) {
        it(`${option || 'default'} on ${JSON.stringify(input)}`, () => {
          compare(`${command} ${option} f`, binary, [...(option ? [option] : []), 'f'], input, false)
        })
      }
    }
  })
}
