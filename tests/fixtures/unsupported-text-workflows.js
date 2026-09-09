export const TEXT_FILES = {
  'src/declarations.js': 'export async function inspect() {}\nexport function parse() {}\n',
  'data/sizes.txt': '12K src/index.js\n2M src/util.js\n800 test/index.test.js\n',
  'data/versions.txt': 'v1.10.0\nv1.2.0\nv2.0.0\n',
}

// Familiar analysis commands whose valid syntax exceeds the implemented subset.
// Expectations identify the missing capability independently of error wording.
export const TEXT_WORKFLOWS = [
  {
    purpose: 'Extract exported names with a PCRE match-start reset',
    command: String.raw`grep -noP 'export \K\w+' src/index.js`,
    expected: [{ kind: 'feature', command: 'grep', detail: 'PCRE escape \\K' }],
  },
  {
    purpose: 'Search with checked-in patterns while reading filename exclusions from a file',
    command: 'grep -rn -f patterns.txt --exclude-from=excluded.txt src README.md',
    expected: [{ kind: 'option', command: 'grep', detail: '--exclude-from' }],
  },
  {
    purpose: 'Produce NUL-delimited filenames containing TODO markers',
    command: 'grep -rlZ TODO src README.md',
    expected: [{ kind: 'option', command: 'grep', detail: '-Z' }],
  },
  {
    purpose: 'Extract complete identifiers while excluding substring matches',
    command: String.raw`grep -owE '[[:alpha:]_]+' src/index.js`,
    expected: [{ kind: 'feature', command: 'grep', detail: '-o regex extent' }],
  },
  {
    purpose: 'Read exported declarations case-insensitively through their closing brace',
    command: String.raw`sed -n '/^export /I,/^}/p' src/index.js`,
    expected: [{ kind: 'feature', command: 'sed', detail: 'address regex flags' }],
  },
  {
    purpose: 'Append one metric record after each README line',
    command: String.raw`sed 'R data/metrics.tsv' README.md`,
    expected: [{ kind: 'feature', command: 'sed', detail: 'script' }],
  },
  {
    purpose: 'Join pairs of input lines into comparison records',
    command: String.raw`sed 'N;s/\n/ /' data/names.txt`,
    expected: [{ kind: 'feature', command: 'sed', detail: 'script' }],
  },
  {
    purpose: 'Normalize import and export prefixes case-insensitively with an extended expression',
    command: String.raw`sed -E 's/^(export|import) /module /I' src/index.js`,
    expected: [{ kind: 'feature', command: 'sed', detail: 'substitution flags' }],
  },
  {
    purpose: 'Preview a case-insensitive replacement of TODO markers',
    command: String.raw`sed 's/todo/DONE/I' README.md`,
    expected: [{ kind: 'feature', command: 'sed', detail: 'substitution flags' }],
  },
  {
    purpose: 'Uppercase selected names in a report without editing its input',
    command: String.raw`sed 's/alpha/\U&/' data/names.txt`,
    expected: [{ kind: 'feature', command: 'sed', detail: 'replacement escape' }],
  },
  {
    purpose: 'Sort collected metric values inside an AWK report',
    command: String.raw`awk 'NR>1 {scores[NR]=$2} END {n=asort(scores);for(i=1;i<=n;i++) print scores[i]}' data/metrics.tsv`,
    expected: [{ kind: 'feature', command: 'awk', detail: 'asort()' }],
  },
  {
    purpose: 'Print a frequency table with its keys sorted explicitly',
    command: String.raw`awk '{count[$0]++} END {n=asorti(count, names);for(i=1;i<=n;i++) print names[i], count[names[i]]}' data/names.txt`,
    expected: [{ kind: 'feature', command: 'awk', detail: 'asorti()' }],
  },
  {
    purpose: 'Tokenize source using matches instead of field separators',
    command: String.raw`awk '{n=patsplit($0, words, /[[:alnum:]_]+/);for(i=1;i<=n;i++) print words[i]}' src/index.js`,
    expected: [{ kind: 'feature', command: 'awk', detail: 'patsplit()' }],
  },
  {
    purpose: 'Request deterministic key order for an associative-array report',
    command: String.raw`awk 'BEGIN {PROCINFO["sorted_in"]="@ind_str_asc"} {count[$0]++} END {for(name in count) print name, count[name]}' data/names.txt`,
    expected: [{ kind: 'feature', command: 'awk', detail: 'PROCINFO[sorted_in]' }],
  },
  {
    purpose: 'Write selected metric columns to a computed report filename',
    command: String.raw`awk -F '\t' 'NR>1 {report="scores.txt";print $1,$2 > report}' data/metrics.tsv`,
    expected: [{ kind: 'feature', command: 'awk', detail: 'output redirection' }],
  },
  {
    purpose: 'Read a repository root from a subprocess inside AWK',
    command: String.raw`awk 'BEGIN {"git rev-parse --show-toplevel" | getline root;print root}'`,
    expected: [{ kind: 'feature', command: 'awk', detail: '"cmd" | getline' }],
  },
  {
    purpose: 'Extract declaration kinds following repeated export and async qualifiers',
    command: String.raw`awk '{if(match($0, /((export|default|async) )+([[:alnum:]_]+)/, parts)) print parts[1],parts[3]}' src/declarations.js`,
    expected: [{ kind: 'feature', command: 'awk', detail: 'regex capture semantics' }],
  },
  {
    purpose: 'Order a size report with human-readable unit suffixes',
    command: 'sort -h data/sizes.txt',
    expected: [{ kind: 'option', command: 'sort', detail: '-h' }],
  },
  {
    purpose: 'Order version strings naturally instead of lexicographically',
    command: 'sort -V data/versions.txt',
    expected: [{ kind: 'option', command: 'sort', detail: '-V' }],
  },
  {
    purpose: 'Sort version numbers while skipping their leading v character',
    command: 'sort -k1.2,1 data/versions.txt',
    expected: [{ kind: 'option', command: 'sort', detail: '-k1.2,1' }],
  },
  {
    purpose: 'Separate runs of duplicate names into visible groups',
    command: 'uniq --group=separate data/names.txt',
    expected: [{ kind: 'option', command: 'uniq', detail: '--group' }],
  },
  {
    purpose: 'Save adjacent-deduplicated names using the output-file operand',
    command: 'uniq data/names.txt data/unique-names.txt',
    expected: [{ kind: 'feature', command: 'uniq', detail: 'output file' }],
  },
  {
    purpose: 'Remove a TSV identifier column while retaining the other fields',
    command: 'cut --complement -f1 data/metrics.tsv',
    expected: [{ kind: 'option', command: 'cut', detail: '--complement' }],
  },
  {
    purpose: 'Preview selected TSV columns with a comma delimiter',
    command: 'cut -f1,2 --output-delimiter=, data/metrics.tsv',
    expected: [{ kind: 'option', command: 'cut', detail: '--output-delimiter' }],
  },
  {
    purpose: 'Collapse repeated whitespace classes in documentation',
    command: String.raw`cat README.md | tr -s '[:space:]'`,
    expected: [{ kind: 'feature', command: 'tr', detail: 'set expressions' }],
  },
  {
    purpose: 'Remove indentation and collapse blank lines in a source preview',
    command: String.raw`cat src/index.js | tr -ds ' \t' '\n'`,
    expected: [{ kind: 'option', command: 'tr', detail: '-d -s' }],
  },
  {
    purpose: 'Number only exported declaration lines',
    command: "nl -b p'^export' src/index.js",
    expected: [{ kind: 'option', command: 'nl', detail: '-b p' }],
  },
  {
    purpose: 'Preview a byte-limited prefix that ends inside a UTF-8 character',
    command: 'head -c4 data/utf8.txt',
    expected: [{ kind: 'feature', command: 'head', detail: 'partial UTF-8 byte sequence' }],
  },
  {
    purpose: 'Read from a byte offset that begins inside a UTF-8 character',
    command: 'tail -c+5 data/utf8.txt',
    expected: [{ kind: 'feature', command: 'tail', detail: 'partial UTF-8 byte sequence' }],
  },
  {
    purpose: 'Measure maximum line width in source and documentation',
    command: 'wc -L src/index.js README.md',
    expected: [{ kind: 'option', command: 'wc', detail: '-L' }],
  },
]
