// Native oracle only. This module is never imported by the runtime.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { URL, fileURLToPath } from 'node:url'
import { SOURCE_TREES } from '../fixtures/source-tree-files.js'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const COMMANDS = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/source-tree-commands.json'), 'utf8'))
export const ENV = { ...process.env, LC_ALL: '', LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8', LC_COLLATE: 'C' }
const tools = ['bash', 'awk', 'grep', 'find', 'xargs', 'sed', 'sort', 'wc', 'od', 'tree']
export const versions = Object.fromEntries(tools.map((name) => {
  const r = spawnSync(name, ['--version'], { encoding: 'utf8', env: ENV })
  return [name, r.status === 0 && /GNU|coreutils|tree v/u.test(r.stdout) ? r.stdout.split('\n')[0] : null]
}))
export const missing = tools.filter((name) => versions[name] === null)
if (process.env.SOURCE_TREE_REQUIRE_NATIVE === '1') assert.deepEqual(missing, [], 'Put GNU tools and tree on PATH')

export function snapshotRepository() {
  const files = { 'package.json': readFileSync(join(ROOT, 'package.json'), 'utf8') }
  for (const sub of ['src', 'tests']) {
    for (const name of readdirSync(join(ROOT, sub))) {
      if (/\.(?:js|ts)$/u.test(name)) files[sub + '/' + name] = readFileSync(join(ROOT, sub, name), 'utf8')
    }
  }
  return files
}

export function materialize(files) {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-source-tree-'))
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return dir
}

export function native(command, dir) {
  const r = spawnSync('bash', ['--noprofile', '--norc', '-c', command], {
    cwd: dir, env: ENV, encoding: 'utf8', input: '', timeout: 20000, maxBuffer: 20 * 1024 * 1024,
  })
  assert.equal(r.error, undefined, command)
  assert.equal(r.signal, null, command)
  let stdout = r.stdout
  // Only the sandbox root differs. Verify pwd before mapping its name.
  if (command === 'pwd') {
    assert.equal(stdout, realpathSync(dir) + '\n')
    stdout = '/\n'
  }
  return { stdout, stderr: r.stderr, exitCode: r.status }
}

if (process.argv.includes('--write-reference')) {
  assert.deepEqual(missing, [], 'Native-only baseline generation requires GNU tools and tree on PATH')
  const trees = {}
  for (const [name, files] of Object.entries(SOURCE_TREES)) {
    const dir = materialize(files)
    try { trees[name] = COMMANDS.map(({ id, command }) => ({ id, ...native(command, dir) })) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }
  writeFileSync(join(ROOT, 'tests/fixtures/source-tree-expected.json'), JSON.stringify({ versions, locale: 'en_US.UTF-8; LC_COLLATE=C', trees }, null, 2) + '\n')
}
