# Shell correctness audit

This branch audits main at `53396dc`, starting with the recent shell expansion,
stream handling, and AWK additions. The runtime remains entirely in JavaScript
over the virtual filesystem. Native programs are used only as test references.

## Corrections

- Shell words retain quote boundaries, empty fragments, carriage returns, and
  Unicode whitespace. Command names receive expansion too. Empty `IFS` disables
  field splitting. Expansion failures preserve earlier output, later pipeline
  stages, and the diagnostic feed. Nested command dispatch isolates shell state.
- `xargs` parses quoted and escaped input, retains empty NUL-delimited arguments,
  and translates child exit statuses. Unsupported option combinations and
  replacement-line quoting are diagnosed.
- ANSI-C quoting and `echo -e` assemble UTF-8 bytes correctly, including NUL
  handling. Byte operations no longer silently substitute replacement characters.
- `cat`, `head`, `tail`, `tac`, and `sed` preserve line endings and empty-input
  behavior. `sort` compares large decimal numbers exactly; `seq` generates exact
  integers. `wc` padding, `uniq` fields, and `tr` complement mapping are corrected.
- `ls` uses non-TTY lexical ordering and correct classification/header behavior.
  Filesystem traversal is depth-first. `basename` and `dirname` operate lexically.
- Globs match filenames containing newlines. Grep handles POSIX classes,
  newline-separated patterns, word boundaries, and leftmost-longest match output.
  Regex compilation errors retain grep's exit status and unsupported diagnostics.
- AWK string offsets count Unicode code points. Unsupported locale-sensitive
  matching, signed NaN formatting, and execution limits produce diagnostics.

## Explicit compatibility limits

Valid forms that cannot be represented faithfully fail with an unsupported
diagnostic, including custom nondefault `IFS` splitting, named-user tilde
expansion, unmodeled shell behavior variables/locales, unsupported descriptor
forms, invalid or partial UTF-8 byte output, `ls -l` metadata, fractional `seq`,
complex `tr` sets, `nl` page delimiters, file-output operands, and unsupported
date formatting. Grep diagnoses unsupported regex dialect extensions and early
termination on shared file input. Find diagnoses `-exec` with inherited input.

This is a tested compatibility subset, not a claim of complete Bash or GNU
utility implementation. Ordinary invalid inputs still receive ordinary errors;
valid but unsupported features also appear in the structured diagnostic feed,
including when stderr is redirected or piped away.

## Validation

- 2,087 tests passed, with zero failures, skips, or TODOs.
- The suite includes a native command differential matrix and the existing GNU
  AWK differential tests. Reference versions: coreutils 9.5, grep 3.11, gawk 5.2.2.
- `npm run lint` and `git diff --check` pass.
- `npm pack --dry-run` includes every runtime JavaScript module.

Run `npm test` and `npm run lint` after installing development dependencies.
For the native comparisons, place GNU coreutils, GNU grep, and GNU awk on `PATH`.
The command matrix also discovers GNU tools with `g` prefixes. Native comparison
groups skip explicitly when their reference binary is unavailable; inspect the
test summary rather than treating a skipped comparison as a pass.

## Second pass: agent workflows

This pass starts from `ced86d9` and prioritizes plausible but corrupt output.

- Grep retains blank-line matches, including through `wc -l`; dot matches
  carriage returns in CRLF input. GNU word-start/end assertions are directional,
  ERE `\t`/`\n`/`\r` do not turn into JavaScript control escapes, and literal
  backslashes survive only-matching extraction. Context output separates files,
  and recursive searches distinguish explicit files from discovered descendants.
- Filesystem operations validate path components before normalizing `..`.
  `dir/../other` works when `dir` is a directory; `file/../other` fails when
  `file` is a regular file, and `missing/../other` fails too. This applies to
  readers, redirections, globs, AWK program/input files, and custom-handler views.
- Find parses depth options at their expression position, leaving option-looking
  `-name` patterns and `-exec` arguments intact. A literal `+` inside child
  arguments is preserved. Root names retain `.`/`..`, and the empty root matches
  `-empty`. Empty `ls` results no longer invent a blank line.
- Sort and filename ordering use UTF-8 lexical order. Sort/uniq case folding
  follows the C locale, avoiding Unicode expansions that merge different records.
  Uniq's skip/width comparison keys operate on bytes without decoding partial
  UTF-8. Numeric options cannot silently become patterns or filenames; supported
  leading head/tail count shorthands and negative seq operands remain supported.
- Pipe `/dev/stdin` aliases share consumption. Regular-file aliases retain the
  original contents and reopen from the beginning, following the existing
  GNU/Linux model. Nested API calls have independent input descriptors. AWK
  handles `/dev/null` and repeated regular-file `/dev/stdin` operands.
- AWK `ENVIRON` and unmodeled `PROCINFO` data, including `sorted_in`, now produce
  diagnostics instead of empty values or ignored iteration settings. Grep
  diagnoses binary matches and non-ASCII regex operations whose results depend
  on an unmodeled locale; literal Unicode searches remain supported.

The added tests include 292 strict native GNU comparisons and focused agent
workflow regressions. Strict comparisons require the behavior to work and do
not accept an unsupported diagnostic as a substitute for the expected output.
The audit remains under `doc/` and is excluded from the npm package.
