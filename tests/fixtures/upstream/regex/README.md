# Henry Spencer regular expression corpus

`spencer.tests` is an unmodified copy of Henry Spencer's BSD/POSIX regular
expression test set (385 vectors), from the alpha3.8 distribution dated
1999-08-10, preserved by Gary Houston:

- Repository: https://github.com/garyhouston/regex
- Revision: `70bc2965604b6b8aaf260049e64c708dddf85334`
- Original file: https://github.com/garyhouston/regex/blob/70bc2965604b6b8aaf260049e64c708dddf85334/tests
- Distribution history: https://garyhouston.github.io/regex/
- License: accompanying unmodified `COPYRIGHT` (Henry Spencer, 1992–1997).

`tests/upstream-gnu-regex.test.js` is this project's independently written
adapter. It runs the portable subset through the virtual terminal's grep and
AWK commands, including leftmost-longest match positions and lengths. The
adapter is not Henry Spencer's original test runner. It invokes no native
commands and does not compile the upstream C implementation.

The original C-library flags for explicit input slices, NUL termination,
newline anchors, and non-beginning/non-ending strings do not map directly to
these shell commands. BSD word-boundary classes and named collation elements
also differ from GNU. The adapter identifies these exclusions explicitly,
and separately tests selected compilation errors that GNU shares. GNU accepts
several expressions this older corpus intentionally rejects (empty patterns,
stacked quantifiers, omitted interval minima, and counts above 255); those
vectors are not used as GNU error expectations. GNU-specific regressions are
written separately in the adapter and cite primary GNU documentation.

These test fixtures are outside the package's `files` allowlist.
