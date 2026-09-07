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

- 1,716 tests passed, with zero failures, skips, or TODOs.
- The suite includes a native command differential matrix and the existing GNU
  AWK differential tests. Reference versions: coreutils 9.5, grep 3.11, gawk 5.2.2.
- `npm run lint` and `git diff --check` pass.
- `npm pack --dry-run` includes every runtime JavaScript module.

Run `npm test` and `npm run lint` after installing development dependencies.
For the native comparisons, place GNU coreutils, GNU grep, and GNU awk on `PATH`.
The command matrix also discovers GNU tools with `g` prefixes. Native comparison
groups skip explicitly when their reference binary is unavailable; inspect the
test summary rather than treating a skipped comparison as a pass.
