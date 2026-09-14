// Records ripgrep 14.1.0's answers for the conformance corpus. Run once, with
// ripgrep installed; the corpus it writes is replayed without it.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stdout } from 'node:process'
import { TREES } from './trees.js'
const ROOT = '/tmp/claude-0/-home-user-terminal/dba287c6-1c31-5e32-bacd-6761c7a68ed7/scratchpad/record'
const materialise = (name) => {
  rmSync(ROOT, { recursive: true, force: true })
  for (const [p, c] of Object.entries(TREES[name])) { mkdirSync(dirname(join(ROOT, p)), { recursive: true }); writeFileSync(join(ROOT, p), c) }
}
materialise('searched')
const unwrap = (s) => s.replaceAll(/^rg: (.*): IO error for operation on \1: /gmu, 'rg: $1: ')
const real = (line, tree) => {
  if (tree) materialise(tree)
  const c = line.replace(/^rg /u, 'rg --sort path ')
  try { const o = execFileSync('bash', ['-c', `{ ${c} ; } 2>/tmp/rec.err`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] })
    return { out: o, err: unwrap(readFileSync('/tmp/rec.err','utf8')), code: 0 } }
  catch (e) { return { out: e.stdout ?? '', err: unwrap(readFileSync('/tmp/rec.err','utf8')), code: e.status ?? -1 } }
}
const COMMANDS = [
  'rg oak', 'rg -n oak', 'rg -i oak', 'rg -l oak', 'rg -c oak', 'rg -v oak a.txt',
  'rg -w oak words.txt', 'rg -n -w oak words.txt', 'rg -F oak a.txt', 'rg oak a.txt',
  'rg oak sub', 'rg oak .', 'rg -n oak d', 'rg oak d.txt', 'rg -l oak sub',
  'rg --hidden oak', 'rg --hidden -l oak', 'rg -uu -l oak', 'rg -u -l oak',
  'rg -n oak no-nl.txt', 'rg -n oak blank.txt', 'rg oak empty.txt', 'rg -c oak README.md',
  'rg -A1 oak blank.txt', 'rg -B1 oak blank.txt', 'rg -C1 oak blank.txt',
  'rg -A0 oak blank.txt', 'rg -C1 -A0 oak blank.txt', 'rg -A0 -C1 oak blank.txt',
  'rg -A2 -A1 oak blank.txt', 'rg -n -e oak -e elm a.txt', 'rg -F -e oak -e elm a.txt',
  'rg -i -s oak a.txt', 'rg -s -i oak a.txt', 'rg -n -N oak a.txt', 'rg -N -n oak a.txt',
  'rg -c -l oak sub', 'rg -l -c oak sub', 'rg -H oak a.txt', 'rg -I oak sub',
  'rg -q oak; echo $?', 'rg -q zzz; echo $?', 'rg zzz; echo $?',
  'rg -n "^oak" a.txt', 'rg -n "oak$" a.txt', 'rg -n "o.k" a.txt', 'rg -n "oak|elm" a.txt',
  'rg -n "\\\\boak\\\\b" words.txt', 'rg -n "[Oo]ak" a.txt', 'rg -n "\\\\w+" no-nl.txt',
  'rg oak nosuch', 'rg oak a.txt nosuch', 'rg -n oak sub sub/deep',
]
// A second tree, for what crosses scripts and what does not.
const SCRIPT_COMMANDS = [
  'rg -n café acc.txt', 'rg -F café acc.txt', 'rg -n 日本語 cjk.txt', 'rg 漢字 cjk.txt',
  'rg -n oak', 'rg -l oak', 'rg -c oak', 'rg -n "^oak" a.txt', 'rg -F oak',
  // Naming only ASCII files keeps the guard out of it, whatever else the tree holds.
  String.raw`rg -n '\w+' a.txt`, 'rg -i oak a.txt',
]
const SCRIPT_REFUSALS = [
  // Unicode-aware matching is ripgrep's everywhere and this runtime's nowhere.
  ['rg -i café acc.txt', 'non-ASCII matching'],
  ['rg . cjk.txt', 'non-ASCII matching'],
  // An ASCII pattern is refused too, because one non-ASCII file is in the tree.
  ['rg -i oak', 'non-ASCII matching'],
  ['rg -w oak', 'non-ASCII matching'],
  [String.raw`rg '\w+'`, 'non-ASCII matching'],
]
const lines = []
for (const command of COMMANDS) {
  const r = real(command)
  // `%` alone is an error with no output; output beside stderr keeps its
  // string and marks the stderr with a trailing `%`.
  if (r.err && !r.out) { lines.push(`${JSON.stringify(command)} => % ${r.code}`); continue }
  const tail = [r.code ? String(r.code) : '', r.err ? '%' : ''].filter(Boolean).join(' ')
  lines.push(`${JSON.stringify(command)} => ${JSON.stringify(r.out)}${tail ? ' ' + tail : ''}`)
}
// What ripgrep answers and this runtime will not guess at. These are its half
// of the contract, so they live beside the recorded answers rather than apart.
const REFUSALS = [
  ['rg -t js oak', '-t'], ['rg -g *.js oak', '-g'], ['rg --files oak', '--files'],
  ['rg --json oak', '--json'], ['rg -o oak', '-o'], ['rg --sort path oak', '--sort'],
  ['rg -uuu oak', '-uuu'], ['rg -h oak', '-h'],
  [String.raw`rg '(a)\1' a.txt`, 'backreference'], [String.raw`rg 'oak(?=x)' a.txt`, 'look-around'],
  [String.raw`rg -- 'oak\n' a.txt`, 'newline in a pattern'],
  ['rg -A abc oak a.txt', '-A value'], [String.raw`rg '[' a.txt`, 'regex parse error'],
  ['rg oak .hidden sub', 'named hidden path'],
]
for (const [command, detail] of REFUSALS) lines.push(`${JSON.stringify(command)} => ! ${detail} 2`)

lines.push('', '# The same commands where one file in the tree is not ASCII.', '@tree scripts')
for (const command of SCRIPT_COMMANDS) {
  const r = real(command, 'scripts')
  if (r.err && !r.out) { lines.push(`${JSON.stringify(command)} => % ${r.code}`); continue }
  const tail = [r.code ? String(r.code) : '', r.err ? '%' : ''].filter(Boolean).join(' ')
  lines.push(`${JSON.stringify(command)} => ${JSON.stringify(r.out)}${tail ? ' ' + tail : ''}`)
}
for (const [command, detail] of SCRIPT_REFUSALS) lines.push(`${JSON.stringify(command)} => ! ${detail} 2`)

const header = `# ripgrep, recorded from rg 14.1.0 with --sort path, its documented stable
# order: the default walk is parallel and leaves order unspecified. Every
# expectation here came from running the real tool over the \`searched\` tree,
# never from what this implementation printed.

@tree searched
`
writeFileSync(join(import.meta.dirname, 'rg.tests'), header + lines.join('\n') + '\n')
stdout.write(`recorded ${lines.length} cases\n`)
