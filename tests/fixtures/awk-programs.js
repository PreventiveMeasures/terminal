// Whole awk programs used by ../awk-programs.test.js. They live here as
// files rather than inline strings because that is how they run: `awk -f
// prog.awk data`, with the program itself coming out of the virtual FS.
// Each carries its own header comment, in awk.
//
// String.raw keeps the backslashes the awk source wrote: in `printf "\n"`
// the escape is awk's to interpret, not JavaScript's.

export const AWK_FILES = {
  // Unbounded loop, unbounded storage, conditional dispatch — the whole Turing-completeness argument, in awk.
  'tm.awk': String.raw`# A Turing machine, driven by a transition table read from a data file.
# Tape is a sparse associative array with signed integer keys; the table
# is keyed by state SUBSEP symbol. Nothing here is awk-specific trickery:
# unbounded loop + unbounded storage + conditional dispatch is the whole
# Turing-completeness argument.

function key(state, sym) { return state SUBSEP sym }

function step(  sym, rule, parts) {
  sym = (pos in tape) ? tape[pos] : "0"
  rule = key(state, sym)
  if (!(rule in delta)) { halted = 1; return 0 }
  split(delta[rule], parts, ",")
  tape[pos] = parts[1]
  pos += (parts[2] == "R") ? 1 : -1
  if (pos < lo) lo = pos
  if (pos > hi) hi = pos
  state = parts[3]
  if (state == "H") halted = 1
  return 1
}

function render(  i, out) {
  out = ""
  for (i = lo; i <= hi; i++) out = out ((i in tape) ? tape[i] : "0")
  return out
}

/^#/ || /^[[:space:]]*$/ { next }

# state symbol -> write move next
{ delta[key($1, $2)] = $3 "," $4 "," $5 }

END {
  state = "A"; pos = 0; lo = 0; hi = 0; steps = 0; halted = 0
  while (!halted && steps < limit) { steps += step() }
  tapestr = render()
  ones = gsub(/1/, "1", tapestr)
  printf "%s: halted=%s steps=%d ones=%d tape=%s\n", name, halted ? "yes" : "no", steps, ones, tapestr
}
`,

  // Rado's 3-state busy beaver: 6 ones in 14 steps.
  'bb3.tm': String.raw`# 3-state, 2-symbol busy beaver: state symbol write move next
A 0 1 R B
A 1 1 R H
B 0 0 R C
B 1 1 R B
C 0 1 L C
C 1 1 L A
`,

  // The 4-state busy beaver: 13 ones in 107 steps.
  'bb4.tm': String.raw`# 4-state, 2-symbol busy beaver
A 0 1 R B
A 1 1 L B
B 0 1 L A
B 1 0 L C
C 0 1 R H
C 1 1 L D
D 0 1 R D
D 1 0 R A
`,

  // A machine that never halts; only the step budget stops it.
  'spin.tm': String.raw`A 0 1 R A
A 1 1 R A
`,

  // One Turing-complete language interpreted by another.
  'bf.awk': String.raw`# A brainfuck interpreter in awk: an interpreter for one Turing-complete
# language written in another. Reads the program from stdin or a file,
# precomputes the bracket map with an explicit stack, then runs it.

function match_brackets(prog,    i, c, top, stack) {
  top = 0
  for (i = 1; i <= length(prog); i++) {
    c = substr(prog, i, 1)
    if (c == "[") stack[++top] = i
    else if (c == "]") {
      if (top == 0) { printf "unmatched ] at %d\n", i > "/dev/stderr"; exit 2 }
      jump[i] = stack[top]; jump[stack[top--]] = i
    }
  }
  if (top > 0) { printf "unmatched [ at %d\n", stack[top] > "/dev/stderr"; exit 2 }
}

function run(prog,    ip, dp, c, out, ops) {
  ip = 1; dp = 0; ops = 0
  while (ip <= length(prog)) {
    c = substr(prog, ip, 1)
    ops++
    if (c == ">") dp++
    else if (c == "<") dp--
    else if (c == "+") tape[dp] = (tape[dp] + 1) % 256
    else if (c == "-") tape[dp] = (tape[dp] + 255) % 256
    else if (c == ".") out = out sprintf("%c", tape[dp])
    else if (c == "[") { if (!tape[dp]) ip = jump[ip] }
    else if (c == "]") { if (tape[dp]) ip = jump[ip] }
    ip++
  }
  printf "%s", out
  printf "[%d brainfuck ops, %d tape cells touched]\n", ops, length(tape) > "/dev/stderr"
}

{ src = src $0 }
END { gsub(/[^][<>+.,-]/, "", src); match_brackets(src); run(src) }
`,

  // Prints `Hello World!` in 906 brainfuck operations.
  'hello.bf': String.raw`++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.
<-.<.+++.------.--------.>>+.>++.
`,

  // Recursion, arrays by reference, `delete` on the way back out.
  'queens.awk': String.raw`# Recursive backtracking: N-queens, counting solutions. Arrays passed to
# a function are by reference; the extra parameters are awk's only local
# variables.
function place(row, n, col, diag1, diag2,   c, found) {
  if (row > n) return 1
  found = 0
  for (c = 1; c <= n; c++) {
    if ((c in col) || ((row - c) in diag1) || ((row + c) in diag2)) continue
    col[c] = diag1[row - c] = diag2[row + c] = 1
    found += place(row + 1, n, col, diag1, diag2)
    delete col[c]; delete diag1[row - c]; delete diag2[row + c]
  }
  return found
}
BEGIN {
  for (n = 4; n <= N; n++) printf "%d-queens: %d solutions\n", n, place(1, n, col, d1, d2)
}
`,

  // A sieve of Eratosthenes, to size an array against a real workload.
  'sieve.awk': String.raw`BEGIN {
  for (i = 2; i * i <= N; i++) if (!(i in composite)) for (j = i * i; j <= N; j += i) composite[j] = 1
  for (i = 2; i <= N; i++) if (!(i in composite)) { count++; last = i }
  printf "primes below %d: %d (largest %d)\n", N, count, last
}
`,

  // Everything a real report needs at once; see its own header.
  'report.awk': String.raw`# The shape a real "complex awk case" takes: several rules, a lookup
# table pulled in with getline, multi-dimensional arrays, match() with
# a capture array, gensub, and a hand-written sort — because asort() is
# a gawk extension this build does not have.

BEGIN {
  FS = " "
  # A second file read directly, not as a main-input operand.
  while ((getline line < owners) > 0) {
    split(line, f, "=")
    owner[f[1]] = f[2]
  }
  close(owners)
}

# Skip comments and blanks without touching the counters.
/^#/ || NF == 0 { next }

# GET /api/v2/users/4711?full=1 HTTP/1.1  →  service "api", version 2
match($7, /^\/(api|static)\/v([0-9]+)\/([a-z]+)/, m) {
  service = m[1]; version = m[2]; route = m[3]
  # Two-dimensional accounting: SUBSEP joins the subscripts.
  hits[service, route]++
  bytes[service, route] += $10
  status[$9]++
  # A route with its ids stripped, for grouping.
  canonical[service, route] = gensub(/\/[0-9]+/, "/{id}", "g", $7)
  switch ($9) {
    case /^5/: errors[service]++; break
    case /^4/: warns[service]++; break
    default: ok[service]++
  }
  total++
  next
}

{ unparsed++ }

# Insertion sort over an index array: gawk's asort() is unavailable, so
# ordering an associative array is the caller's job.
function sort_by_value(counts, out,    k, n, i, j, tmp) {
  n = 0
  for (k in counts) out[++n] = k
  for (i = 2; i <= n; i++) {
    tmp = out[i]
    for (j = i - 1; j >= 1 && counts[out[j]] < counts[tmp]; j--) out[j + 1] = out[j]
    out[j + 1] = tmp
  }
  return n
}

function human(n) {
  if (n >= 1048576) return sprintf("%.1fM", n / 1048576)
  if (n >= 1024) return sprintf("%.1fK", n / 1024)
  return sprintf("%dB", n)
}

END {
  printf "%-8s %-10s %-30s %6s %9s %8s  %s\n", "SERVICE", "ROUTE", "CANONICAL", "HITS", "BYTES", "SHARE", "OWNER"
  n = sort_by_value(hits, order)
  for (i = 1; i <= n; i++) {
    split(order[i], k, SUBSEP)
    printf "%-8s %-10s %-30s %6d %9s %7.1f%%  %s\n", k[1], k[2], canonical[order[i]], hits[order[i]],
      human(bytes[order[i]]), 100 * hits[order[i]] / total, (k[1] in owner) ? owner[k[1]] : "-"
  }
  printf "\n%d requests, %d unparsed; ", total, unparsed
  for (s in errors) printf "%s: %d 5xx / %d 4xx / %d ok  ", s, errors[s], warns[s], ok[s]
  printf "\nstatus codes: "
  nstat = sort_by_value(status, codes)
  for (i = 1; i <= nstat; i++) printf "%s=%d ", codes[i], status[codes[i]]
  print ""
}
`,

  // The lookup table report.awk reads with `getline` in BEGIN.
  'owners.txt': String.raw`api=platform-team
static=cdn-team
`,

  // A log with a comment, a blank line, and one line no rule matches.
  'access.log': String.raw`# synthetic access log
10.0.0.1 - - [08/Sep/2026:12:00:00 +0000] "GET /api/v2/users/1001?full=1 HTTP/1.1" 200 900
10.0.0.2 - - [08/Sep/2026:12:00:01 +0000] "GET /api/v2/users/1002?full=1 HTTP/1.1" 200 950
10.0.0.3 - - [08/Sep/2026:12:00:02 +0000] "GET /api/v2/users/1003?full=1 HTTP/1.1" 404 120
10.0.0.4 - - [08/Sep/2026:12:00:03 +0000] "GET /api/v2/orders/2001?full=1 HTTP/1.1" 200 2400
10.0.0.5 - - [08/Sep/2026:12:00:04 +0000] "GET /api/v2/orders/2002?full=1 HTTP/1.1" 503 90

10.0.0.6 - - [08/Sep/2026:12:00:05 +0000] "GET /api/v2/search/3001?full=1 HTTP/1.1" 500 300
10.0.0.7 - - [08/Sep/2026:12:00:06 +0000] "GET /static/v1/assets/4001?full=1 HTTP/1.1" 200 180000
10.0.0.8 - - [08/Sep/2026:12:00:07 +0000] "GET /static/v1/assets/4002?full=1 HTTP/1.1" 200 220000
garbage line that no rule matches
`
}
