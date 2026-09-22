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
`printf` `test` `cp` `rm` `mkdir` `touch` `ln` `diff` `patch` `du` `stat` `realpath`
`pwd` `seq` `which` `basename` `dirname` — plus your own, via `opts.commands`.
It has more besides: `gzip`, `gunzip`, `zcat` and `gzcat`, `brotli`, `base32`,
`od`, `xxd`, `sha1sum`, `sha256sum`, `sha384sum`, `sha512sum`, `shasum`,
`whoami`, `date`, `true` and `false`, and — where the caller asked for a
network — `curl`. The compressors, the digests and `curl` are
there only where the runtime can do the work — a format its streams do not
know, a crypto it does not have, or no `fetch` at all is a command this
terminal does not have either.

Every one of them completes. The shorter list is the one a `command not found`
prints after `Available:`, which is for someone who has just been told a name
is not a command and is looking for the one that is — so it is the everyday
commands for reading a tree, and leaves out what that person was not reaching
for: the compressors, the digests and the dumps above, and `basename`,
`dirname`, `ln`, `cp`, `rm`, `mkdir`, `touch` and `patch`, all of which the
terminal runs and completes as readily as the rest.

The only names it does not complete are the shell's own — `:`, `export`,
`set`, `unset`, `break`, `continue` and `exit` — which are syntax rather than
something a terminal hands out, and a wired command given `hidden: true`,
which is what that flag is for.

A file may be bytes rather than text: a source entry that is a `Uint8Array` is
the file's own bytes, for what no JS string can spell — an image, a compiled
object, an archive — and `{ format: 'base64', data }` is the same file spelt
in base64, for a tree that arrives serialized as text: it is decoded the first
time the file is read, so a tree of many such files costs nothing until one is
opened, and a spelling that does not decode is reported by that first reader,
as a binary file read as text is. Bytes that do spell text are that text, and
read exactly as the string would. Where they spell none, what the file is measured, sized,
listed, copied, encoded or compared as is answered from the bytes themselves:
`wc`, whose characters are the ones those bytes do spell, `stat`, `du`, `ls`,
`find`, `cp` and `cp -r` into the overlay, `base64`, `hexdump`, `xxd`, and
`diff`, which calls two files binary and says only whether they differ,
exactly where GNU does. `cat` hands them on: a pipe and a file both take
bytes, so `cat img.png | hexdump -C`, `cat f.gz | gzip -d | base64` and
`cat img.png > /tmp/copy` all read the file itself, and only this terminal's
own output — a string — cannot carry them, which the command writing them
there reports. A `{ }`, a `( )`, an `if` or a loop standing in a pipeline
reads what a command standing there would, and the commands inside it share
that one input as the commands of any list do: `cat f.tgz | { gzip -d; }`
reads the member, and what one command in the braces takes is not there for
the next to take again. What reads such bytes as text names the input and reports an
unsupported diagnostic rather than mangling it — `head`, `sed`, `awk` and the
rest, whether the bytes came from a file, a redirection or a pipe, and
`diff -a`. A search
answers where it can do so without printing what it cannot: a plain literal
that is nowhere in the bytes selects nothing there, so `grep -r` and `rg`
pass over such a file as the real tools print nothing for it, while a pattern
that could be in it, or `-v`, which selects every line a pattern does not, is
refused — `grep` with the binary-input diagnostic it gives for any file it
calls binary, `rg` by naming the file it cannot search. `grep -I` passes over
one as it passes over any other binary file, and an `rg` walk passes over
what ripgrep itself calls binary: a file holding a NUL, which it never reads
past.

`cp -r` copies a tree into the overlay, making each directory before what goes
inside it; `-R` and `--recursive` spell the same flag, and `-v` announces a
directory once, where it is made. A destination inside the source, a
destination that is the source, and a directory over a file are refused with
GNU's own diagnostics. Directories exist in the overlay only where `cp -r` puts
them, since nothing else here makes one. A link is the one thing it does not
carry over: `-r` keeps every link it meets as the link it is, and `cp` makes
none here, so such a copy is refused rather than written as the files those
links point at. A link handed to `cp` without `-r`
is read through, which is what GNU reads there too, and one `-n` has left
alone is never in question, since that flag answers from the destination
before the source is opened. A destination is read the
way GNU reads one: a regular file can be written through a link and a
directory cannot, so a file copy follows the destination link and a directory
copy answers for the name itself, and a destination leading nowhere is refused
rather than made.

A write lands where a name leads: the overlay answers for the file a link
names, so `echo x > out` with `out -> /tmp/out` writes that file, and one
naming a path in the read-only sources is refused as any other name there is.
The name a link leads to answers for its own parent, so a link into a
directory that is not there fails as the kernel fails it, before the read-only
filesystem is reached. `rm` and `sed -i` are the two that answer for the name
itself — the first takes it away, the second writes a file over it — so a link
the sources hold is read-only to them however the file it names could be
written. `patch` answers for the name too, and refuses it outright: GNU
patches a regular file and nothing else, so a link operand is `not a regular
file -- refusing to patch` whatever it leads to, while a link on the way to
the file is followed as any other component is.

`mkdir` makes them one at a time and `mkdir -p` makes a whole path, passing
over what is already there and naming the component it stops at. A name a link
holds is a name already taken, which making a directory never follows; `-p`
follows it, and passes over only a link that leads to a directory. `rm -r`
takes a tree away again, emptying a directory before removing it. The overlay's
`/tmp` is where it is mounted rather than something inside it, so `rm -r /tmp`
is refused as the busy device Linux calls a mount point, and nothing in it is
removed on the way to finding that out.

`touch` creates the empty files it names, and `-c` leaves an absent name alone.
Times are the half it cannot answer: every entry carries the one time the
terminal was made, so a name already there reports an unsupported diagnostic
rather than a success that changed nothing, and `-a`, `-m`, `-d`, `-t` and `-r`
are refused for the same reason.

`ln -s` makes a symbolic link in the overlay, holding the target as it was
written — resolved from the link's own directory when the link is read, as the
kernel resolves one, whether or not it leads anywhere. One operand makes the
link in the current directory under the target's last component; a name that
is a directory takes the link inside it, unless `-T`, or `-n` for a link to
one; `-t` names that directory outright; `-f` replaces a file or a link in the
way and refuses a directory; `-r` writes the target relative to the link; and
`-v` announces each link made. What is left is a name every other command
reads as it reads a link the sources declare, and `rm` takes away as the link
it is. A hard link — `ln` without `-s` — reports an unsupported diagnostic, as
do backups and the interactive prompt.

`ls -l` fills in what the filesystem does not keep with one deliberate model
rather than a guess per entry: every entry is the session user's alone
(`-rw-------` and `drwx------`) and is dated to the moment the terminal was
created, a time its forks carry with them. Link counts, directory sizes and
the `total` line are what ext4 would report for the same tree, and `-h`
rounds sizes as `du -h` does. A symbolic link — one a source entry declares,
or one `ln -s` made — is the row the model has nothing to guess at:
the `lrwxrwxrwx` every link on Linux carries, the length of the path it holds
as its size, and that path named after it.

`du -b` measures UTF-8 content bytes recursively, including hidden files;
`du -bs src` reports a directory total. `--apparent-size` (also accepted as the
BSD `-A`) supports block and human-readable units, and `--inodes` counts
entries. Plain `du`, `du -sh` and the rest report what ext4 would allocate for
the same tree — the model `ls -l` reads its `total` from: 4 KiB blocks, a
directory taking one, an empty file none, and a link whose target is under 60
bytes none — so a total reads as it would from a disk holding the tree, block
size and all. A link is measured as the link it is, which
is what `-P` asks for and what `du` does without being asked; `-D` and `-H`
measure what an operand points at, and `-L`, which would measure what every
link in a walk points at, reports an unsupported diagnostic where it meets one.

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

A walk stops at a symbolic link rather than crossing it, which is where `find`,
`rg` and `grep -r` all stop: `find` reports the link as the entry it is, and
the two searches pass over it, as neither follows one without being asked.
`grep -R` is the asking, and it reads the file a link names under the link's
own name, saying so of a link that names nothing; only a link to a directory —
the tree it would have to walk into — is refused, and only where an
`--exclude-dir` rule has not already kept the name out. `tree` names a link
beside what it points at and crosses it no further, while its counts and its
`-F` marks follow where the name leads: a link to a directory is one of the
directories, listed by `-d` as they are and marked on the target rather than
on itself.

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
exist. A name a directory holds and cannot read — a link leading nowhere, or
one that loops — is answered for as that read rather than as a type of its
own, whatever is across from it, and what stopped the read is what is said.
`-y`, `-e`, `-B`, `-I` and the rest report an unsupported diagnostic.

`patch` applies unified, context and normal diffs (and git-style headers,
including renames), locating each hunk by line number, then nearby, then
with fuzz, exactly as GNU patch does, with the same messages, reject files,
`.orig` backups, `-p`, `-R`, `-N`, `-f`, `-t`, `-E`, `-l`, `-F`, `-i`, `-o`,
`-d`, `-r`, `-b`, `-z`, `--dry-run` and `--reject-format`. It writes only
inside a writable `/tmp/` overlay; a target anywhere else is refused with an
unsupported diagnostic, while `--dry-run` and `-o -` work everywhere. Ed
scripts and git binary patches are refused the same way.

`curl` is the one command that reaches outside, and the one no terminal has
unless it was asked for: `createTerminal` takes `network: true`, and without
it the name is not a command, which is what it was before `curl` was written —
a line that reaches for it is told that and no more, since how the terminal
was built is the caller's business rather than the line's. It makes its request with the
runtime's own `fetch`, over http and https alone; every other scheme, on the
URL or on a redirect it was told to follow, is refused as the protocol this
terminal does not speak, `file:` included. A request carries what the command
line gave it and nothing off the host: no environment, no `.netrc`, no cookie
jar, no client certificate, no proxy.

What it carries of curl: `-s`, `-S`, `-i`, `-I`, `-L` with `--max-redirs`,
`-f`, `-X`, `-H`, `-A`, `-u`, `-d` with `--data-raw`, `--data-binary`,
`--data-ascii` and `--json` — `@file` reading the virtual tree and `@-` the
pipe — `-o`, `-O`, `-m`, `--compressed`, which the runtime does anyway, and
`-h`, which lists what this curl carries rather than what curl has.
Several URLs run one after another, `-o` and `-O` pair with them in the order
both were written, and the status is the last transfer that failed, in curl's
own numbers: 3 for a URL, 6 for a name that did not resolve, 7 for a
connection that did not open, 22 for `-f` over a failing status, 23 for an
output it could not write, 28 for `--max-time`, 47 for the end of a redirect
chain, 56 for an answer that stopped early, and 60 for a certificate. What
comes back is bytes, as it is for every other command here that writes what no
string need spell, so `curl url > /tmp/f.png` and `curl url | sha256sum` read
the answer itself and `-o` writes it into the overlay — which, being the only
writable place here, is where an output file must be. A transfer is one
request and its answer: there is no connection to reuse, no cookie jar, no
resume, and no progress meter, since there is no terminal to draw one on. The
options that would ask for those — `-k`, `-v`, `-x`, `-b`, `-c`, `-w`, `-T`,
`-F`, `-G`, `-r`, `-E`, `--retry`, `--connect-timeout` and the rest — report
an unsupported diagnostic naming what would have to exist for them to work,
rather than being accepted and quietly dropped. Two things read differently
from the real tool, and the run says the first of them on the note channel:
`-i` prints a header block rendered from what `fetch` hands back — names
lowercased and sorted, under a status line that reads `HTTP/1.1` whichever
version the connection spoke — and a header the runtime reserves for itself is
the runtime's to set, so `-H` can add to a request but not take away from it.

`realpath` supports GNU canonicalization modes (`-e`, `-m`, and the default),
relative output (`--relative-to`, `--relative-base`), quiet errors (`-q`) and
NUL terminators (`-z`). It resolves paths within the virtual filesystem, each
of the three ways GNU offers: `-P`, the default, expands every link it walks
through, `..` taken from what the link leads to; `-L` takes `..` from the name
as written, cancelling the component before it; and `-s` expands no link at
all, asking the filesystem only whether what the name leads to is there.

Behaviour is checked against the real tools: bash 5.2, GNU grep 3.11, GNU sed
4.9, gawk 5.2, ripgrep 14.1, GNU diff 3.10 and GNU patch 2.7.6 in the C
locale, alongside the BusyBox, GNU/Spencer regex and Oils spec corpora.
