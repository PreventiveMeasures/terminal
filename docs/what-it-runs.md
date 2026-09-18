# What it runs

Pipelines, `&&`/`||`/`;`/`!`, subshells and groups, `if`, `for … in`,
`while` / `until`, `[[ … ]]` and `test`, redirects and heredocs, brace
expansion, globs with bracket expressions, `$(…)` and backticks, `$(( … ))`,
and the `${…}` family. A loop that never ends is stopped and reported, since
nothing here runs beside the line.

`set -e` is the one shell option here, and it stops the line where bash stops
a script — including at the places bash pointedly does not look: a `&&`/`||`
chain before the command it ends on, a condition, a `!`, every stage of a
pipeline but the last, and a compound command other than a subshell that ends
on any of those. Everything else `set` can be asked for is refused whole:
applying the `-e` of `set -eu` would run the line under half of what it asked.

`name() { … }` runs wherever the name is called, while its body reads and
writes no variable — then a call cannot tell itself from the line it stands
in, and `$1`, a `local` and the rest are nothing the body could have read. A
body that needs any of them is refused rather than run as something it is
not.

`ls` `cd` `cat` `grep` `rg` `egrep` `fgrep` `sed` `awk` `find` `head` `tail` `wc`
`tree` `sort` `uniq` `cut` `tr` `nl` `tac` `hexdump` `base64` `xargs` `echo`
`printf` `test` `cp` `rm` `mkdir` `touch` `diff` `patch` `du` `stat` `realpath`
`pwd` `seq` `which` `basename` `dirname` — plus your own, via `opts.commands`.

`cp -r` copies a tree into the overlay, making each directory before what goes
inside it; `-R` and `--recursive` spell the same flag, and `-v` announces a
directory once, where it is made. A destination inside the source, a
destination that is the source, and a directory over a file are refused with
GNU's own diagnostics. Directories exist in the overlay only where `cp -r` puts
them, since nothing else here makes one.

`mkdir` makes them one at a time and `mkdir -p` makes a whole path, passing
over what is already there and naming the component it stops at. `rm -r` takes
a tree away again, emptying a directory before removing it. The overlay's own
`/tmp` is where it is mounted rather than something inside it, so `rm -r /tmp`
is refused as the busy device Linux calls a mount point, and nothing in it is
removed on the way to finding that out.

`touch` creates the empty files it names, and `-c` leaves an absent name alone.
Times are the half it cannot answer: every entry carries the one time the
terminal was made, so a name already there reports an unsupported diagnostic
rather than a success that changed nothing, and `-a`, `-m`, `-d`, `-t` and `-r`
are refused for the same reason.

`ls -l` fills in what the filesystem does not keep with one deliberate model
rather than a guess per entry: every entry is the session user's alone
(`-rw-------` and `drwx------`) and is dated to the moment the terminal was
created, a time its forks carry with them. Link counts, directory sizes and
the `total` line are what ext4 would report for the same tree, and `-h`
rounds sizes as `du -h` does.

`du -b` measures UTF-8 content bytes recursively, including hidden files;
`du -bs src` reports a directory total. `--apparent-size` (also accepted as the
BSD `-A`) supports block and human-readable units, and `--inodes` counts
entries. Allocated disk sizes are unavailable, so plain `du` and `du -sh`
report an unsupported diagnostic.

`rg` covers the search itself: recursion, `-n -N -i -s -w -v -F -a -l -c -e -q
-H -I -A -B -C -u`, and skipping hidden entries unless `--hidden`. Options are
last-one-wins and `-u` escalates, as in ripgrep. Its regex is checked against
ripgrep's own engine, so backreferences and look-around are refused rather than
answered. `.gitignore` in a repository, `.ignore` and `.rgignore` change which
files are searched -- from any directory above the starting point as well as
below it -- so a tree carrying one is refused unless `--no-ignore`;
binary files are left out of a walk but a named one is refused, and `-t`, `-g`,
`--files` and the other output modes report an unsupported diagnostic. A
pattern spelling out a newline, and a file starting with a byte-order mark, are
refused rather than answered differently from ripgrep. Literal matching crosses
scripts, but Unicode-aware matching does not: `-i`, `-w`, `.` and `\w` over a
tree holding any non-ASCII file report an unsupported diagnostic.

`grep`, `sed` and `awk` read a regular expression the way GNU does in the
C.UTF-8 locale, from glibc's own tables: `.` and a bracket take one character,
accented or not; the named classes, `\w`, `\s`, `\b`, `\<`, `\>` and `-w` go by
the locale's letters, digits and spaces, so `grep -rn 'fn\b' .` answers over a
tree with accented text in it; and `-i`, sed's `I` and awk's `IGNORECASE` fold
case as GNU does, letter by letter — `s` stands for `s`, `S` and `ſ`, the
Kelvin sign for itself alone, and a range runs between its endpoints' upper
cases, so `[a-{]` takes `_` under `-i`. A range or a collating element with a
character past ASCII in it is GNU's "Invalid collation character", as it is in
C.UTF-8. What still reports an unsupported diagnostic over non-ASCII text:
`-P`, whose PCRE reads its own tables; `-i` with a backreference; and case
folding over the Cyrillic Extended-C letters, which GNU's two matchers read
differently.

The locale is C.UTF-8 and nothing else: `$LANG` answers it, and a `LANG`,
`LC_ALL` or `LC_CTYPE` set to any other value, or a `LANG` unset, is refused,
since every command would read text differently there and none of that is
implemented. The other `LC_` categories also take `C` and `POSIX`, which
read the same as C.UTF-8 in them. `createTerminal` takes `locale: 'C.UTF-8'`
and nothing else.

`stat -c '%s %n' file` reports byte size and name; `%F` reports file type.
`--printf` adds escape processing and controls line endings. Default `stat`
output, directory byte sizes, and fields requiring ownership, permissions,
timestamps or other absent metadata report an unsupported diagnostic.

`diff` compares files and, with `-r`, directories, in normal, unified (`-u`,
`-U N`) and context (`-c`, `-C N`) format, with `-q`, `-s`, `-N`, `-x`, `-a`,
`-i`, `-w`, `-b`, `-Z`, `--strip-trailing-cr`, `-p`, `-L` and `-d`. The diff
itself comes from [`@preventive/diff`](https://www.npmjs.com/package/@preventive/diff),
which runs the linear-space Myers algorithm GNU diff uses and checks its own
work twice over: the change set is replayed against the first file, and what
is printed is read back and held to the change set. Neither a change set that
would not reconstruct the second file nor a rendering that does not say what
it was given is ever printed — both are refused as trouble instead, so no
diff this terminal emits loses a line. Which of several shortest change sets
it picks can differ from GNU's; given the same change set, the bytes are
GNU's. The virtual filesystem keeps no modification
times, so headers carry the name alone, as they do under `--label`; a file
`-N` stands in for gets the epoch, which is what tells `patch` it did not
exist. `-y`, `-e`, `-B`, `-I` and the rest report an unsupported diagnostic.

`patch` applies unified, context and normal diffs (and git-style headers,
including renames), locating each hunk by line number, then nearby, then
with fuzz, exactly as GNU patch does, with the same messages, reject files,
`.orig` backups, `-p`, `-R`, `-N`, `-f`, `-t`, `-E`, `-l`, `-F`, `-i`, `-o`,
`-d`, `-r`, `-b`, `-z`, `--dry-run` and `--reject-format`. It writes only
inside a writable `/tmp/` overlay; a target anywhere else is refused with an
unsupported diagnostic, while `--dry-run` and `-o -` work everywhere. Ed
scripts and git binary patches are refused the same way.

`realpath` supports GNU canonicalization modes (`-e`, `-m`, and the default),
relative output (`--relative-to`, `--relative-base`), quiet errors (`-q`) and
NUL terminators (`-z`). It resolves paths within the virtual filesystem.

Behaviour is checked against the real tools: bash 5.2, GNU grep 3.11, GNU sed
4.9, gawk 5.2, ripgrep 14.1, GNU diff 3.10 and GNU patch 2.7.6 in the C
locale, alongside the BusyBox, GNU/Spencer regex and Oils spec corpora.
