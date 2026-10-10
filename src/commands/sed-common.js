import { UnsupportedError, unsupported, unsupportedFrom } from '../unsupported.js'

export const SED_SUBSET = 'sed: supported commands are p, P, n, N, d, D, a, i, c, g, G, h, H, x, l, w, W, r, R, q, Q, =, F, z, y, v, :, b, t, T, #, { }, and s/regexp/replacement/[NgiIpw]'
// A budget of commands between two reads of input: a loop that reads as it
// goes ends with its input, so only one that never reads can spend it.
export const MAX_SED_STEPS = 1_000_000
export const MAX_SED_SPACE = 16 * 1024 * 1024
export const MAX_SED_OUTPUT = 64 * 1024 * 1024
export function scriptGap(detail = 'script') { throw new UnsupportedError('feature', detail, SED_SUBSET) }

// GNU's other way out: panic, for a fault that is no fault of the script's,
// says only what went wrong and exits 4.
export const panic = (message) => Object.assign(new Error(message), { exitCode: 4 })

export function sedFailure(e) {
  if (e.gap) return unsupported('feature', 'sed', e.gap, `sed: ${e.message}`)
  if (e instanceof RangeError) return unsupported('feature', 'sed', 'regex runtime limit', `sed: ${e.message}`)
  return unsupportedFrom(e, 'sed', `sed: ${e.message.replace(/^sed: /u, '')}`, e.exitCode)
}

// sed 4.9's usage(), which it prints to stderr with a status of 1 when it has
// no script or an option it cannot read, and to stdout for --help.
export const SED_USAGE = `Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...

  -n, --quiet, --silent
                 suppress automatic printing of pattern space
      --debug
                 annotate program execution
  -e script, --expression=script
                 add the script to the commands to be executed
  -f script-file, --file=script-file
                 add the contents of script-file to the commands to be executed
  --follow-symlinks
                 follow symlinks when processing in place
  -i[SUFFIX], --in-place[=SUFFIX]
                 edit files in place (makes backup if SUFFIX supplied)
  -l N, --line-length=N
                 specify the desired line-wrap length for the \`l' command
  --posix
                 disable all GNU extensions.
  -E, -r, --regexp-extended
                 use extended regular expressions in the script
                 (for portability use POSIX -E).
  -s, --separate
                 consider files as separate rather than as a single,
                 continuous long stream.
      --sandbox
                 operate in sandbox mode (disable e/r/w commands).
  -u, --unbuffered
                 load minimal amounts of data from the input files and flush
                 the output buffers more often
  -z, --null-data
                 separate lines by NUL characters
      --help     display this help and exit
      --version  output version information and exit

If no -e, --expression, -f, or --file option is given, then the first
non-option argument is taken as the sed script to interpret.  All
remaining arguments are names of input files; if no input files are
specified, then the standard input is read.

GNU sed home page: <https://www.gnu.org/software/sed/>.
General help using GNU software: <https://www.gnu.org/gethelp/>.
`
