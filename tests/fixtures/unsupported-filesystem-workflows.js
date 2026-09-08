// Commands an agent might use to inspect repository layout, metadata,
// execution context or structured files. All execute in the virtual shell.
const gap = (purpose, command, owner, detail, kind = 'option') => ({
  purpose, command, expected: [{ kind, command: owner, detail }],
})
const unavailable = (purpose, command, owner) => gap(purpose, command, owner, owner, 'command')

export const FILESYSTEM_WORKFLOWS = [
  gap('Locate unusually large source files', 'find src -type f -size +1M', 'find', '-size'),
  gap('Find files changed during the last week', 'find src -type f -mtime -7', 'find', '-mtime'),
  gap('Match complete test file paths with a regex', String.raw`find test -regex '.*\.test\.js'`, 'find', '-regex'),
  gap('Print file paths alongside their sizes', String.raw`find src -type f -printf '%p\t%s\n'`, 'find', '-printf'),
  gap('Stop after the first matching entry', "find src -name '*.js' -print -quit", 'find', '-quit'),
  gap('Follow links while searching source files', "find -L src -type f -name '*.js'", 'find', '-L'),
  gap('Find alternative names for an entry point', 'find . -samefile src/index.js', 'find', '-samefile'),
  gap('Identify executable files', 'find src -type f -perm -111', 'find', '-perm'),
  gap('Run an analysis command from each containing directory', String.raw`find src -type f -execdir wc -l {} \;`, 'find', '-execdir'),
  gap('Read search roots from a NUL-delimited manifest', 'find -files0-from data/roots.list -type f', 'find', '-files0-from'),
  gap('Remove generated temporary files discovered by find', "find src -name '*.tmp' -delete", 'find', '-delete'),
  gap('Compare file modification times with the package manifest', 'find src -newer package.json', 'find', '-newer'),

  gap('Count source lines using parallel batches', "find src -type f -print0 | xargs -0 -P4 -n1 wc -l", 'xargs', '-P'),
  gap('Treat each filename line as a single argument', String.raw`cat data/paths.txt | xargs -d '\n' wc -l`, 'xargs', '-d'),
  gap('Read filename arguments directly from a manifest', 'xargs -a data/paths.txt wc -l', 'xargs', '-a'),
  gap('Show expanded commands before executing them', 'echo src/index.js | xargs -t wc -l', 'xargs', '-t'),
  gap('Process one filename line per invocation', 'cat data/paths.txt | xargs -L1 wc -l', 'xargs', '-L'),
  gap('Bound the size of command argument batches', 'cat data/paths.txt | xargs -s1024 wc -l', 'xargs', '-s'),

  gap('Inspect source ownership and permissions', 'ls -l src', 'ls', '-l metadata', 'feature'),
  gap('List the largest source files first', 'ls -S src', 'ls', '-S'),
  gap('Request stable timestamps in a detailed listing', 'ls --time-style=long-iso -l src', 'ls', '--time-style'),
  gap('Disable terminal color in a listing', 'ls --color=never src', 'ls', '--color'),
  gap('Quote filenames so they can be reused in shell commands', 'ls --quoting-style=shell-escape src', 'ls', '--quoting-style'),

  gap('Exclude dependencies and build artifacts from a tree', "tree -I 'node_modules|dist' .", 'tree', '-I'),
  gap('Honor gitignore while showing a shallow tree', 'tree -L2 --gitignore .', 'tree', '--gitignore'),
  unavailable('Measure the disk usage of source files', 'du -sh src', 'du'),
  unavailable('Inspect the byte size of an entry point', "stat -c '%s %n' src/index.js", 'stat'),
  unavailable('Resolve a source path to an absolute path', 'realpath src/index.js', 'realpath'),

  unavailable('Search for unfinished work with ripgrep', "rg -n 'TODO|FIXME' src", 'rg'),
  unavailable('List version-controlled files', 'git ls-files', 'git'),
  unavailable('Summarize the size of pending changes', 'git diff --stat', 'git'),
  unavailable('Read package scripts with a JSON query', "jq '.scripts' package.json", 'jq'),
  unavailable('Inspect the package version through Node', `node -p "require('./package.json').version"`, 'node'),
  unavailable('Run the package test command', 'npm test', 'npm'),
  unavailable('Parse the manifest using Python', `python3 -c "import json; print(json.load(open('package.json'))['name'])"`, 'python3'),
  unavailable('Compare two source files', 'diff -u src/index.js src/util.js', 'diff'),
  unavailable('Compare sorted name lists', 'comm -23 data/declared-names.txt data/used-names.txt', 'comm'),
  unavailable('Save a listing while passing it down a pipeline', 'find src -type f | tee data/paths.txt', 'tee'),
  unavailable('Identify a source file format', 'file src/index.js', 'file'),
  unavailable('Hash an entry point to detect changes', 'sha256sum src/index.js', 'sha256sum'),
]
