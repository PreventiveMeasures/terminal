// How diff decides two lines are the same. GNU hashes each line under the
// active options (io.c find_and_hash_each_line); the key here is the string
// that hash would see, so equal keys are exactly GNU's equal lines. Records
// keep their terminator: a last line without one is a different line from a
// complete one, except under the whitespace options, where the newline is
// whitespace like any other.

// C-locale isspace: the newline is one of them.
const SPACE = /[ \t\n\v\f\r]/gu
const SPACE_RUN = /[ \t\n\v\f\r]+/gu
const TRAILING_SPACE = /[ \t\n\v\f\r]+$/u

// C-locale tolower folds ASCII only.
const fold = (text) => text.replace(/[A-Z]/gu, (c) => c.toLowerCase())

// null means identity: compare records as they are.
export function lineKey({ ignoreCase = false, whitespace = 'none' } = {}) {
  let key = null
  if (whitespace === 'all') key = (line) => line.replace(SPACE, '')
  // A run of blanks reads as one space, unless it runs to the end of the line.
  else if (whitespace === 'change') key = (line) => line.replace(TRAILING_SPACE, '').replace(SPACE_RUN, ' ')
  else if (whitespace === 'trailing') key = (line) => line.replace(TRAILING_SPACE, '')
  if (!ignoreCase) return key
  return key ? (line) => fold(key(line)) : fold
}

// Records with their terminators; the last may lack one.
export function splitRecords(text) {
  const records = []
  for (let pos = 0; pos < text.length;) {
    const end = text.indexOf('\n', pos)
    const next = end < 0 ? text.length : end + 1
    records.push(text.slice(pos, next))
    pos = next
  }
  return records
}

// --strip-trailing-cr edits the text before it is split, so the output
// shows the stripped lines too, as GNU's does.
export const stripTrailingCr = (text) => text.replace(/\r\n/gu, '\n')

// GNU looks for a NUL in the first block it reads; a file this size is read
// whole, so the whole file is what is looked at.
export const isBinary = (text) => text.includes('\0')
