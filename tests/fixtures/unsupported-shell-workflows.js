// Real shell workflows whose missing behavior must remain visible to agents.
// Expectations name the missing capability explicitly, independent of stderr.
const feature = (detail, command = null) => [{ kind: 'feature', command, detail }]
const option = (command, detail) => [{ kind: 'option', command, detail }]

export const SHELL_FILES = { 'config/shell.env': 'PROJECT_NAME=terminal\n' }

export const SHELL_WORKFLOWS = [
  {
    purpose: 'Check read permissions before inspecting a package manifest',
    command: 'test -r package.json && cat package.json',
    expected: feature('-r', 'test'),
  },
  {
    purpose: 'Check that project documentation is nonempty',
    command: '[ -s README.md ] && head -n 20 README.md',
    expected: feature('-s', '['),
  },
  {
    purpose: 'Quote matching source paths for reuse as shell input',
    command: String.raw`printf '%q\n' src/*.js`,
    expected: feature('%q', 'printf'),
  },
  {
    purpose: 'Read the first metrics row into a shell variable',
    command: 'read -r header < data/metrics.tsv',
    expected: feature('read', 'read'),
  },
  {
    purpose: 'Collect newline-separated names into a shell array',
    command: 'mapfile -t modules < data/names.txt',
    expected: feature('mapfile', 'mapfile'),
  },
  {
    purpose: 'Enable strict shell error handling before an audit',
    command: 'set -euo pipefail',
    expected: feature('set', 'set'),
  },
  {
    purpose: 'Make unmatched source globs expand to an empty list',
    command: 'shopt -s nullglob',
    expected: feature('shopt', 'shopt'),
  },
  {
    purpose: 'Load repository-specific shell configuration',
    command: 'source config/shell.env',
    expected: feature('source', 'source'),
  },
  {
    purpose: 'Check whether an analysis command is available',
    command: 'command -v awk',
    expected: feature('command', 'command'),
  },
  {
    purpose: 'Stop exporting a configuration variable to child commands',
    command: 'export -n NODE_ENV',
    expected: option('export', '-n'),
  },
  {
    purpose: 'Remove an already-processed entry from a file array',
    command: "unset 'files[0]'",
    expected: feature('array subscript', 'unset'),
  },
  {
    purpose: 'Sort a name list using an explicitly selected UTF-8 locale',
    command: 'LC_ALL=en_US.UTF-8 sort data/names.txt',
    expected: feature('LC_ALL'),
  },
  {
    purpose: 'Include project-local tools in command lookup',
    command: 'PATH=./node_modules/.bin:/usr/bin which awk',
    expected: feature('PATH'),
  },
  {
    purpose: 'Split a colon-separated directory list',
    command: 'paths=src:test; IFS=:; echo $paths',
    expected: feature('IFS'),
  },
  {
    purpose: 'Save a source line-count report to a variable-selected path',
    command: 'report=analysis.txt; wc -l src/*.js > "$report"',
    expected: feature('>'),
  },
  {
    purpose: 'Use a shell regex conditional to identify a package manifest',
    command: '[[ package.json =~ [.]json$ ]] && cat package.json',
    expected: feature('[[ =~'),
    parseTime: true,
  },
  {
    purpose: 'Replace source path separators with parameter expansion',
    command: 'name=src/index.js; echo "${name//\\//_}"',
    expected: feature('${'),
    parseTime: true,
  },
  {
    purpose: 'Extract a fixed-width source path prefix with parameter expansion',
    command: 'file=src/index.js; echo "${file:0:3}"',
    expected: feature('${'),
    parseTime: true,
  },
  {
    purpose: 'Print an audit completion message when the shell exits',
    command: "trap 'echo audit complete' EXIT",
    expected: feature('trap', 'trap'),
  },
  {
    purpose: 'Compute a source excerpt end using legacy arithmetic syntax',
    command: 'start=10; end=$[start + 20]; echo "$end"',
    expected: feature('$['),
    parseTime: true,
  },
  {
    purpose: 'Read a generated documentation excerpt through process substitution',
    command: 'cat <(head -n 10 README.md)',
    expected: feature('<('),
    parseTime: true,
  },
  {
    purpose: 'Save project documentation as an analysis artifact',
    command: 'cat README.md > report.txt',
    expected: feature('>'),
    parseTime: true,
  },
  {
    purpose: 'Process a newline-separated list of filenames without losing spaces',
    command: 'while IFS= read -r file; do wc -l "$file"; done < data/paths.txt',
    expected: feature('while'),
    parseTime: true,
  },
  {
    purpose: 'Wait until a generated source report becomes available',
    command: 'until test -f generated/report.json; do sleep 1; done',
    expected: feature('until'),
    parseTime: true,
  },
  {
    purpose: 'Exclude test files when counting JavaScript source lines',
    command: 'for file in src/*.js; do case "$file" in *.test.js) continue;; *) wc -l "$file";; esac; done',
    expected: feature('case'),
    parseTime: true,
  },
  {
    purpose: 'Define a reusable source-summary shell function',
    command: 'summarize() { wc -l src/*.js; }; summarize',
    expected: feature('function'),
    parseTime: true,
  },
  {
    purpose: 'Inspect successively larger documentation excerpts with a numeric loop',
    command: 'for ((i=1; i<=3; i++)); do head -n "$i" README.md; done',
    expected: feature('for (('),
    parseTime: true,
  },
  {
    purpose: 'Gather source and test globs into a shell array',
    command: 'files=(src/*.js test/*.js)',
    expected: feature('array assignment'),
    parseTime: true,
  },
  {
    purpose: 'Run a source line-count audit in the background',
    command: 'wc -l src/*.js &',
    expected: feature('&'),
    parseTime: true,
  },
  {
    purpose: 'Capture a line count using legacy command-substitution syntax',
    command: 'count=`wc -l < README.md`; echo "$count"',
    expected: feature('`'),
    parseTime: true,
  },
]
