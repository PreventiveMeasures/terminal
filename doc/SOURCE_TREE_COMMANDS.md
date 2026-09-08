# 50 commands for source-tree analysis

These are the 50 workflows selected before this pass's implementation changes.
Run them from a project root containing `package.json`, `src/index.js`, `src/`,
and `tests/`. They cover navigation, inventories, searches, byte/line inspection,
source summaries, and shell composition. Some searches legitimately return no
matches (exit 1); a no-match child of xargs yields its native exit 123.

## Verification

Every workflow has exact stdout, stderr, and exit-status checks. An unsupported
diagnostic fails these comparisons, even if a pipeline exits successfully.

- **150 permanent checks:** each command on ordinary, edge-case, and sparse trees,
  compared with saved output generated exclusively by native tools.
- **200 live checks:** the same three trees plus a current repository snapshot
  (`package.json` and the top-level `.js`/`.ts` files in `src/` and `tests/`).
- Edge fixtures include empty files, missing final newlines, CRLF, Unicode names
  and content, spaces, apostrophes, leading hyphens, nested directories, a binary
  file, duplicate lines, and searches with no matches.
- Native references: GNU Bash 5.2.37, grep 3.11, awk 5.2.2, findutils 4.10.0,
  coreutils 9.5, sed 4.9, tree 2.1.1, and the host's `xxd`.
  Text uses `en_US.UTF-8`; ordering uses `LC_COLLATE=C`. Only the absolute `pwd`
  root is mapped to the virtual `/`, after checking the native path.

The catalog is `tests/fixtures/source-tree-commands.json`; fixture source and
saved native outputs are beside it. With the above tools on PATH:

```sh
SOURCE_TREE_REQUIRE_NATIVE=1 node --test tests/source-tree-workflows.test.js tests/source-tree-features.test.js
```

To regenerate the saved outputs **from native tools only**:

```sh
node tests/helpers/source-tree-reference.js --write-reference
```

Without those tools, the 150 saved-reference checks still run; live tests report
an explicit skip. `SOURCE_TREE_REQUIRE_NATIVE=1` turns missing tools into failure.
The JS runtime never invokes native commands. This document and all tests are
excluded from the npm package by its explicit runtime-file allowlist.

## Commands

1. **Locate the tree root**

   ```sh
   pwd
   ```

2. **List top-level entries including dotfiles**

   ```sh
   ls -AF
   ```

3. **Inspect the first two directory levels**

   ```sh
   tree -a -L 2
   ```

4. **Inventory every file**

   ```sh
   find . -type f -print | sort
   ```

5. **Inventory JavaScript and TypeScript sources and tests**

   ```sh
   find src tests -type f \( -name '*.js' -o -name '*.ts' \) -print | sort
   ```

6. **Inventory files while pruning dependencies**

   ```sh
   find . -type d -name node_modules -prune -o -type f -print | sort
   ```

7. **Find empty source files**

   ```sh
   find src -type f -empty -print | sort
   ```

8. **Rank JavaScript files by line count**

   ```sh
   find src -type f -name '*.js' -exec wc -l {} + | sort -nr
   ```

9. **Measure JavaScript file sizes with NUL-safe filenames**

   ```sh
   find src -type f -name '*.js' -print0 | sort -z | xargs -0 -r wc -c
   ```

10. **Read package metadata**

   ```sh
   cat package.json
   ```

11. **Read the entry point header**

   ```sh
   head -n 40 src/index.js
   ```

12. **Read the entry point footer**

   ```sh
   tail -n 20 src/index.js
   ```

13. **Read a specific entry point range**

   ```sh
   sed -n '20,60p' src/index.js
   ```

14. **Read a numbered source range**

   ```sh
   nl -ba src/index.js | sed -n '15,35p'
   ```

15. **Inspect tabs, CRLF, and other nonprinting bytes**

   ```sh
   cat -A src/index.js
   ```

16. **Inspect the first 64 source bytes**

   ```sh
   xxd -l 64 src/index.js
   ```

17. **Inspect a three-byte prefix**

   ```sh
   head -c 3 src/index.js | od
   ```

18. **Find outstanding work markers**

   ```sh
   grep -rInE 'TODO|FIXME|XXX' src tests | sort
   ```

19. **Find environment-variable accesses**

   ```sh
   grep -rInF 'process.env' src | sort
   ```

20. **Find exported declarations**

   ```sh
   grep -rInE 'export[[:space:]]+(default|const|function|class)' src | sort
   ```

21. **Find imports and re-exports**

   ```sh
   grep -rInE '^(import|export).*from' src | sort
   ```

22. **Find CommonJS dependency loads**

   ```sh
   grep -rInE 'require\(' src | sort
   ```

23. **Find dynamic code evaluation references**

   ```sh
   grep -rInE '(eval|Function)[[:space:]]*\(' src | sort
   ```

24. **Find child-process execution references**

   ```sh
   grep -rInE '(exec|spawn)(Sync)?[[:space:]]*\(' src | sort
   ```

25. **Find prototype-related code**

   ```sh
   grep -rInF '__proto__' src | sort
   ```

26. **Find network endpoints and fetch calls**

   ```sh
   grep -rInE '(https?://|fetch\()' src | sort
   ```

27. **Find console logging**

   ```sh
   grep -rInE 'console\.(log|warn|error)' src | sort
   ```

28. **Find explicit error throws**

   ```sh
   grep -rInE 'throw[[:space:]]+new[[:space:]]+Error' src | sort
   ```

29. **Find catch clauses**

   ```sh
   grep -rInE 'catch[[:space:]]*\(' src | sort
   ```

30. **Find test and suite declarations**

   ```sh
   grep -rInE '(it|test|describe)[[:space:]]*\(' tests | sort
   ```

31. **Read context around the public entry point**

   ```sh
   grep -n -C 2 'createTerminal' src/index.js
   ```

32. **Search production JS while excluding colocated tests**

   ```sh
   grep -rIn --include='*.js' --exclude='*.test.js' 'TODO' src | sort
   ```

33. **List files containing outstanding work**

   ```sh
   grep -rIl 'TODO' src | sort
   ```

34. **List files without outstanding work**

   ```sh
   grep -rIL 'TODO' src | sort
   ```

35. **Rank per-file outstanding-work counts**

   ```sh
   grep -rIc 'TODO' src | sort -t: -k2,2nr
   ```

36. **Detect the package module mode**

   ```sh
   grep -q '"type": "module"' package.json && echo esm || echo other
   ```

37. **Count repeated JSON key spellings**

   ```sh
   grep -oE '"[^"]+"[[:space:]]*:' package.json | sort | uniq -c | sort -nr
   ```

38. **Rank identifier spellings immediately before opening parentheses**

   ```sh
   grep -rIhoE '[A-Za-z_][A-Za-z0-9_]*\(' src | sort | uniq -c | sort -nr | head -n 20
   ```

39. **Extract module specifiers from single-line imports**

   ```sh
   grep -rIh '^import ' src | awk -F "[\"']" '{print $2}' | sort -u
   ```

40. **Summarize JavaScript files by second path component**

   ```sh
   find src -type f -name '*.js' -print | awk -F/ '{print $2}' | sort | uniq -c | sort -nr
   ```

41. **Find source lines longer than 100 characters**

   ```sh
   awk 'length($0)>100 {printf "%s:%d:%d\n", FILENAME,FNR,length($0)}' src/*.js | sort
   ```

42. **Count blank source lines**

   ```sh
   awk 'NF==0 {blank++} END {print blank+0}' src/*.js
   ```

43. **Summarize source records and characters excluding newlines**

   ```sh
   awk '{lines++; chars+=length($0)} END {printf "lines=%d chars=%d\n", lines,chars}' src/*.js
   ```

44. **Count outstanding work by source filename**

   ```sh
   awk '/TODO/ {count[FILENAME]++} END {for (file in count) print count[file],file}' src/*.js | sort -nr
   ```

45. **Inspect source with trailing blanks removed**

   ```sh
   sed 's/[[:blank:]]*$//' src/index.js | cat -A
   ```

46. **Find duplicated source lines**

   ```sh
   sort src/index.js | uniq -d
   ```

47. **Count case-insensitive repeated work-marker lines**

   ```sh
   grep -rIh 'TODO' src | sort -f | uniq -ci | sort -nr
   ```

48. **Search safely sorted NUL-delimited filenames**

   ```sh
   find src -type f -name '*.js' -print0 | sort -z | xargs -0 -r grep -nH -e TODO -e FIXME
   ```

49. **Preview each top-level JavaScript source**

   ```sh
   for f in src/*.js; do echo "=== $f ==="; head -n 3 "$f"; done
   ```

50. **Read a header then continue the same file stream**

   ```sh
   { head -n 5; echo '--- remainder ---'; cat; } < src/index.js
   ```

## Fixes exercised by this list

- Grouped `find` expressions preserve precedence, negation, short-circuit actions,
  pruning, global traversal depths, implicit printing, and batched commands.
- `sort -z` retains NUL record boundaries, empty records, and embedded newlines,
  including numerical/field sorting and deduplication.
- `grep -I` treats early-detected binary inputs as selecting no lines, retaining
  operands for counts and nonmatching filename lists. Late binary discovery
  remains explicitly diagnosed because native output depends on read buffering.
- Compatible ASCII regexes work on Unicode source text. Width-sensitive patterns,
  case/word rules, and unmodeled locale classes retain diagnostics when needed.
- `sed` supports numeric print addresses and BRE substitutions, including `g`,
  `p`, captures, `&`, alternate delimiters, and ordered scripts. Record endings
  remain correct across files and replacements that insert newlines. Other sed
  commands/flags and unmodeled regex/capture behavior report diagnostics.
- `wc` quotes newline-containing filenames instead of forging extra output rows.

Passing this corpus establishes the behavior of these workflows on the tested
inputs; it is not a claim that every possible shell or utility construct works.
