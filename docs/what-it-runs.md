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
It has more besides: `gzip`, `gunzip`, `zcat` and `gzcat`, `brotli`, `tar`,
`zip` and `unzip`, `base32`, `od`, `xxd`, `sha1sum`, `sha256sum`, `sha384sum`,
`sha512sum`, `shasum`, `whoami`, `date`, `true` and `false`, and — where the
caller asked for a network — `curl`. The compressors, `zip` and `unzip`, the
digests and `curl` are
there only where the runtime can do the work — a format its streams do not
know, a crypto it does not have, or no `fetch` at all is a command this
terminal does not have either.

Every one of them completes. The shorter list is the one a `command not found`
prints after `Available:`, which is for someone who has just been told a name
is not a command and is looking for the one that is — so it is the everyday
commands for reading a tree, and leaves out what that person was not reaching
for: the compressors, the archivers, the digests and the dumps above, and `basename`,
`dirname`, `ln`, `cp`, `rm`, `mkdir`, `touch` and `patch`, all of which the
terminal runs and completes as readily as the rest.

The only names it does not complete are the shell's own — `:`, `export`,
`set`, `unset`, `break`, `continue` and `exit` — which are syntax rather than
something a terminal hands out, and a wired command given `hidden: true`,
which is what that flag is for.

A command named by a path — `/bin/echo`, `/usr/bin/printf`, `/usr/bin/[` — or
run by `xargs` or `find -exec` is the program of that name rather than bash's
builtin, as it is under bash: `echo`, `printf`, `test` and `[`, `true`, `false`
and `pwd` then answer as coreutils' do, which read escapes, report a number
they cannot read and word their errors differently from the builtins, and
`--help` or `--version` alone, which the programs answer and this does not
carry, is refused. The builtins sign what they say as bash signs its own
messages, with this shell's name, `terminal: `, where bash's is `bash: ` —
`terminal: printf: x: invalid number`, `terminal: [: missing `]'` — but for
a usage line, which bash prints bare; the programs sign nothing. A GNU tool
run by its path names itself by that path in what it says, as it does
there. The command lines themselves are read as
GNU's tools read them: `tail +N` and `tail -N` where at most one operand
follows, `head -5c`, `seq` and `tr` taking options only before their
operands, a missing option argument or a flag handed one in getopt's words
followed by the tool's own pointer at `--help`, and file names and other
operands quoted the way coreutils quotes them in C.UTF-8 — `cat: '*.log': No
such file or directory`, `head: invalid number of lines: ‘1x’`. `xargs`
builds command lines of at most 128 KiB, GNU's default, and starts another
where the next argument would not fit.

A file may be bytes rather than text: a source entry that is a `Uint8Array` is
the file's own bytes, for what no JS string can spell — an image, a compiled
object, an archive — and `{ format: 'base64', data }` is the same file spelt
in base64, for a tree that arrives serialized as text: it is decoded when the
terminal is made, and a spelling that does not decode is refused there, as
every source that cannot be what it declares is. Every file is bytes in the
end — the tree is an `@preventive/vfs` one, and a file declared as text holds
what that text encodes to — so bytes that do spell text are that text, and
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
the next to take again. What `xargs` runs hands its bytes on the same way, so
`echo f.gz | xargs gzip -dc | base64` reads the member too. What reads such bytes as text names the input and reports an
unsupported diagnostic rather than mangling it — `head`, `sed`, `awk` and the
rest, whether the bytes came from a file, a redirection or a pipe, and
`diff -a`.

`grep` searches a file that is not text as GNU grep does. A NUL in GNU's first
read — 96 KiB of a file, 64 KiB of a pipe — makes the file binary: records end
at each NUL as at a newline, nothing of the file is printed, and a selection
says `grep: FILE: binary file matches` on stderr, in its place among the rest
of the output; `-c`, `-l`, `-L` and `-q` count and list the file as any other.
A byte that spells no character makes only the lines holding one binary. Every
line is still searched, and no `.`, set or literal takes such a byte for a
character, while a word edge beside it reads it as the Latin-1 character of
that value, as glibc's regex does. A line holding one is held back wherever it
would be printed, selected or as context, and the file is said to match once
the search is done with it. `-I` passes over a file with a NUL in that first
read and holds such lines back without saying so; `-a` prints them as the
bytes they are, which a pipe or a file takes. What is refused: a NUL found
past that first read, where what GNU prints before it depends on how it reads
the rest, and for the same reason context (`-A`, `-B`, `-C`) around held-back
lines in a file larger than that read; `-P`, whose PCRE reads bytes that are
not UTF-8 by its own rules; a pattern holding an unpaired surrogate, which no
bytes spell; and, beside a character glibc reads past U+10FFFF or a surrogate
spelt in UTF-8, a pattern GNU's two matchers would answer differently. `rg`
passes over a file of bytes that spell no text where a plain literal is
nowhere in it and refuses it by name where one could be, and does the same
for such bytes piped into it. A NUL is what ripgrep calls binary, and it reads
as ripgrep does: in 64 KiB fills after a first one of three bytes, so a walked
file holding one is searched up to the fill that brings it, what it selected
there is printed, and `PATH: WARNING: stopped searching binary file after
match (found "\0" byte around offset N)` follows; a count says nothing of the
file, and `--files-without-match` neither lists it nor exits 1 over it.
Standard input holding a NUL is read to its end with each NUL a line end, a
count counting every line, and closes with `binary file matches (found "\0"
byte around offset N)`. Refused: context around, or `-h` lines from, a binary
file read in part; a named binary file; and, beside a line over 64 KiB long,
a search that prints from a binary file whose NUL is past its first 64 KiB,
since the buffer ripgrep grew for that line is kept for the files its thread
searches next, and which those are turns on thread order.

The terminal's own stdin and stdout are a terminal's: nothing can be typed
into it, and it shows text. A command reads the terminal where nothing was
piped or redirected into it — a file, `/dev/null` and a here-document are no
terminal — and writes to it where its output goes neither down a pipe nor into
a file. Where a tool will not read an archive or a compressed stream from a
terminal, or write one to it, it refuses here as it does there: `tar -t` with
no `-f` says "Refusing to read archive contents from terminal", `gzip` and
`gunzip` that compressed data is not written to or read from a terminal,
`brotli` to use `-f`, and `zip -` that it cannot write a zip file to terminal.
Given `-f`, `gzip` takes the terminal as GNU's does: nothing is typed there,
so it decompresses nothing from it, and compresses it to an empty member.
What `xargs` runs reads `/dev/null`, as it does under GNU's xargs, so a `tar`
run there finds no archive rather than a terminal.

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

`rg` covers the search itself: recursion, `-n -N -i -s -w -x -v -F -a -l -c -e
-q -H -I -A -B -C -u`, and skipping hidden entries unless `--hidden`. Options
are last-one-wins and `-u` escalates, as in ripgrep, and standard input is
named `<stdin>`. A pattern is read as Rust's regex syntax, joined to the others
as ripgrep shows them, `(?:p1)|(?:p2)`: one Rust rejects gets ripgrep's own
`regex parse error` report, carets and all — a backreference, look-around, an
unclosed class or group, a stray repetition, a range out of order, an escape
Rust does not know, a newline spelt out — and what Rust reads but this does
not follow is refused: nested classes and class set operations, inline flags,
`\p`, a repetition of an assertion or of a repetition, and counts over 1000.
A count or a `--files-without-match` exits 0 where it printed anything, as
ripgrep's do. `.gitignore` in a repository, `.ignore` and `.rgignore` change
which files are searched -- from any directory above the starting point as
well as below it -- so a tree carrying one is refused unless `--no-ignore`;
`-t`, `-g`, `--files` and the other output modes report an unsupported
diagnostic, as does a file starting with a byte-order mark. Literal matching
crosses scripts, but Unicode-aware matching does not: `-i`, `-w`, `.` and `\w`
over a tree holding any non-ASCII file report an unsupported diagnostic.

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
`-P`, whose PCRE reads its own tables; `-i` with a backreference; case
folding over the Cyrillic Extended-C letters, which GNU's two matchers read
differently; and `-w` with a pattern that can match nothing, over a character
past ASCII that is no word character, inside which GNU, reading bytes, finds
an empty match.

`grep` checks a pattern as GNU grep 3.11 does, with glibc's regex and then
its dfa, and says what they say: each pattern line glibc rejects is reported in
glibc's words (`grep: Unmatched [, [^, [:, [., or [=`, `Invalid content of
\{\}`, `Trailing backslash`), after `FILE:LINE: ` for a line read by `-f`; the
dfa's own errors and warnings follow (`character class syntax is
[[:space:]], not [:space:]`, `warning: * at start of expression`). A
backslash inside a bracket is a member of it, and a BRE `\{` with nothing
before it is a `{`. `-P` reports in PCRE2's words, takes one pattern, and
reads `\x` with no digits as NUL. The options die where GNU's do and as
GNU's do — `invalid context length argument`, `invalid max count`,
`conflicting matchers specified`, an option missing its argument, the
two-line usage — `-m` below zero is no limit, the long spellings and `-y`
are accepted, and `-h`/`-H` and `-l`/`-L` go to the last given, either of
the latter outranking `-c`. `--include` and `--exclude` match a named file by
its whole name or any part of it after a `/`, and a walked one by its base
name; `--exclude-dir` drops trailing slashes and also passes over a named
directory, never the `.` a bare `-r` starts from. Where the two matchers read
a stray operator apart — a repetition right after an anchor, an ERE interval
with nothing before it, a BRE `$` before a bare `)` or `|` mid-pattern — which of them answers
depends on the search, and the pattern is refused.

The locale is C.UTF-8 and nothing else: `$LANG` answers it, and a `LANG`,
`LC_ALL` or `LC_CTYPE` set to any other value, or a `LANG` unset, is refused,
since every command would read text differently there and none of that is
implemented. The other `LC_` categories also take `C` and `POSIX`, which
read the same as C.UTF-8 in them. `createTerminal` takes `locale: 'C.UTF-8'`
and nothing else.

`sed` runs a script as GNU sed 4.9 does, with `-n`, `-e`, `-f`, `-E` and `-r`,
`-s`, `-z`, `-l`, `--sandbox`, and `-i` with or without a backup suffix: every
address — `0,/re/`, `first~step`, `addr,+N` and `addr,~N` among them — and
every command but `e`, from `#n` on a script's first line to `l` wrapped at
its width, `Q`, `F`, `z`, `v`, `r`, `R`, `w` and `W`, and in a replacement the
`\U`, `\L`, `\u`, `\l` and `\E` case conversions and the `\x`, `\o`, `\d` and
`\c` escapes. A script it cannot compile is wrong in GNU's words and at GNU's
place — `-e expression #2, char 5:` or `file s.sed line 3:` ahead of the
message, the character counted in bytes — and no script, or an option
missing its argument, prints GNU's usage. A bracket takes a backslash for
itself, as POSIX has it, so `[\]` and `[\.]` match what GNU's do, while `\n`,
`\t` and the other escapes sed rewrites before its regex sees them stand for
their characters there too. A directory handed to `-f` is a script with
nothing in it, which is what GNU reads from one. Output to a pipe or a file is
held in blocks of 4096 bytes as glibc's stdio holds it, and a line at a time
on the terminal, so under `2>&1` a diagnostic lands where GNU's lands — ahead
of whatever output was still held — and one that would land inside a
character is refused. A closed stdout is `couldn't write N items to stdout`
when a block fills and `couldn't close stdout` at the end, status 4, which is
also the status of a `w` file that cannot be opened and of an `-i` backup that
cannot be put in place. A loop that never reads input is stopped after a
million commands; one that reads as it goes runs as long as its input does.
What reports an unsupported diagnostic: `e` and the `M` flag, a backreference
inside a regex, `-u`, `--posix`, `--debug`, `--follow-symlinks` and
`--version`, an `l` width taken from `COLS`, `r` and `R` reading stdin or a
file the same script writes, and `-i` outside the writable `/tmp/` overlay.

`awk` is gawk 5.2.1. It reads a program with gawk's own grammar, through
parse tables built the way Bison builds gawk's and a lexer that reads as
gawk's does, so a program gawk runs is read the same, and one gawk rejects is
rejected at the token gawk stops at, with all gawk has printed by then: the
line, a caret under the token and gawk's message — down to a program that
opens with an empty line, or a `-f` file that ends inside a rule. Every
message is gawk's, placed where gawk places it: `awk: cmd. line:3:` or the
`-f` file's name, `(FILENAME=… FNR=…)` once input has been read, `fatal:`
with exit 2, `error:` with exit 1, a `warning:` and the run goes on, and a
command line gawk cannot read answered with gawk's usage and exit 1. `for (k
in a)` walks an array in gawk's order, from the same three hash tables gawk
keeps; `rand()` is gawk's random(3)-based generator, seed for seed, and
`srand()` with no argument seeds from the clock as gawk does. Values are
gawk's: a field past `NF` is unassigned, `$0 = 30` keeps a number, `NF = 2.7`
keeps 2.7, a record is rebuilt with the `CONVFMT` in force when it is next
read, the right side of an assignment is evaluated before its target, and `^`
with an integer exponent multiplies as gawk's does. What is refused, by name:
writing to a file other than `/dev/stdout`, `/dev/stderr` and `/dev/null`
(a target only the run knows is refused when it is reached); everything that
runs a process — `system()`, `cmd | getline`, `print | cmd`, `|&`; `@` and
what it begins (indirect calls, typed regexes, `@include`); namespaces;
arrays of arrays; `asort`, `asorti`, `patsplit`, `strftime`, `mktime`,
`mkbool`, the gettext functions and `typeof()`'s second argument; `ENVIRON`
and the parts of `PROCINFO` that describe a process; options other than
`-f`, `-F` and `-v`; calls nested deeper than 100; a regex `RS` that can
match the empty string before the end of its input, or one with a word
boundary after a word character; an interval count above 1000; a NaN printed
with its sign; and a backslash before a character outside ASCII in a string
or a regex, whose warning gawk prints as a lone byte.

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

`gzip`, `gunzip`, `zcat` and `gzcat` compress and decompress through the
runtime's stream as GNU gzip 1.12 does, with `-c`, `-d`, `-k` and `-f`, which
takes a terminal, a link, and a name already taken or already named as
compressed, and decompressing to stdout hands on unchanged what is not gzip
data, as `zcat -f` of a plain file. Without it a link is refused, as GNU
refuses one, and a name already taken is asked about where stdin is the
terminal, which answers with its end. What another compressor made —
compress, pack, a zip — GNU gzip also reads, and it is refused here, as is a
compression level.

`tar` lists (`-t`), extracts (`-x`) and creates (`-c`) archives as GNU tar
1.35 does, with its listings, messages and statuses: the old-style `tar czf`
spelling and getopt's, `-f`, `-v` and `-vv`, `-z` and `-a`, the positional
`-C`, `-O`, `-k`, `--strip-components`, `--numeric-owner`, `--utc`, `-b`,
`--format` of `gnu` or `ustar`, and `--sort=name`, which is the order this
tree is walked in anyway. `-O` moves every listing to stderr, `--utc` asks for
the long listing whatever `-v` says, and at `-vv` an extraction names each
directory it made on the way to an entry. With several operands, a file met a
second time under another name — `src` and then `-C src a.txt` — is stored as
a hard link to the first, as GNU stores it; met under the same name, it would
be a hard link to itself, which the package will not write, so that is
refused. GNU holds a whole record in memory, and a `-b` past 32768 blocks,
16 MiB, is refused. A closed stdout is `/dev/null` opened for reading to GNU:
a listing it would take is lost, and said to be once the run is over, a
member `-O` writes there is an error of its own, and an archive for it is
written nowhere — but through gzip, which is refused. The archive is read and
written by [`@preventive/archive`](https://www.npmjs.com/package/@preventive/archive),
whose writer puts down byte for byte what GNU tar writes for the same entries —
but for a name too long for its header, which goes in a header of GNU's own
ahead of it, where GNU records the host's names for user and group 0, `root`
on most systems, unless under `--numeric-owner`, and the package records
none; no reader lists or uses them — and whose reader is strict: an archive it will not read whole — damaged,
truncated, or holding a name that climbs out of it — is refused with an
unsupported diagnostic, where GNU would list or extract what it could and
complain of the rest. A gzip archive goes through the runtime's stream, found
by `-z`, by its first bytes or by its name as GNU finds one, and what gzip
would say of a damaged one is said; another compressor is refused. An archive
made here records this tree as `ls -l` describes it — files `-rw-------`,
directories `drwx------`, everything dated to the moment the terminal was made
— and an owner and group, which a header records as numbers this terminal does
not have, as it has no `$UID`: `tar -c` asks for them with
`--owner=NAME:UID --group=NAME:GID`, or as ids under `--numeric-owner`, and
refuses rather than making them up. `--format=pax`, whose headers carry access
and change times, is refused for the same reason. The package keeps no `.`
segment in a name, so a name GNU would store with one — anything under a `.`
operand — is refused rather than stored differently. It reads names the same
way, handing `./a` out as `a` and a directory as its name without a slash
however it was stored, beside the name as stored; GNU prints and matches
every name as it is stored, so an archive holding a name the package cleans —
`./a`, `d/./b`, a directory stored without its slash, a hard link to `./f` —
is refused, as is one with an entry for its own root. `tar` warns of a pax keyword GNU does not know as GNU does, as it
comes to the entry: macOS's `LIBARCHIVE.xattr.` records are warned of, while
`SCHILY.xattr.` records pass without a word. An access or change time GNU
would complain of, and the records of multi-volume and incremental archives,
are refused. Extraction writes into the writable `/tmp/` overlay alone, which
holds no hard link and no device, so an entry that would make one is refused
too. The overlay keeps no times either, so an entry dated before 1970 or after
the run began, which GNU warns of once it has written it, is refused as well.

`zip` makes a new archive as Info-ZIP Zip 3.0 does — `-r`, `-j`, `-D`, `-0`,
`-y` and `-q`, its `adding:` lines, warnings, refusal of one name for two
files, and statuses — each file deflated through the runtime's stream wherever
that makes it smaller, and one whose name says it is compressed already —
`.zip`, `.Z`, `.zoo`, `.arc`, `.lzh` or `.arj` — stored as it is. The package
stores a whole archive or deflates what deflate makes smaller, so a file by
one of those names that deflate would make smaller, beside another file it
makes smaller, is refused. That deflate is the runtime's rather than
Info-ZIP's, so the share a file reports saved is this archive's, and can be a
few points away from what Info-ZIP's would be: 56% for the numbers 1 to 400,
a line each, where Info-ZIP saves 53%. Adding to an archive already there, a
file operand `-`, which Info-ZIP reads from stdin, a compression level and the
rest are refused. `unzip` answers as Debian's UnZip 6.00 does: `-l`, dated
year first, `-t`, `-p`, and extraction with `-q`, `-o`, `-n` — which wins over
`-o`, with UnZip's caution, where both are given — `-j`, `-d` and `-x`, the
overwrite question included — UnZip asks it on stdin, and a stdin with
nothing on it answers with its end, which UnZip takes as "None". A link is
made last, its name held until then by a placeholder of its target, as UnZip
holds it, so a later entry of that name, which `-j` can make, meets it as it
would there. A name stored with a `.` segment, which Info-ZIP never writes
and other tools do, is refused as tar's is, since UnZip lists it as stored. The
package does not say how an entry was stored, nor whether its time is an exact
one or a DOS time, so an extraction that is not quiet — which names each file
`extracting` or `inflating` by how it was stored — `-c`, and `-v` or the
second `-l` that UnZip reads as one, are refused, and `-l` answers where the
two readings of every time agree, which they always do under `TZ=UTC`.

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
A hop `-L` takes carries what the request carried, less what it should not:
a redirect to another origin — another host, another scheme, another port —
goes without the `Authorization`, `Cookie` and `Proxy-Authorization` the first
request had, since a credential is addressed to the origin it was given for
and the next origin was named by the answer rather than by whoever wrote the
line. curl drops them for the same reason without `--location-trusted`, which
is refused here. Several URLs run one after another, `-o` and `-O` pair with
them in the order both were written, and the status is the last transfer that failed, in curl's
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
locale, GNU tar 1.35 and Info-ZIP Zip 3.0 and UnZip 6.00 in C.UTF-8,
alongside the BusyBox, GNU/Spencer regex and Oils spec corpora.
