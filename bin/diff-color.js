// Colours diff output in the development REPL. Not part of the published
// package: the library returns plain text, and only this REPL paints it.
//
// The format is recognised from its own structural markers rather than from
// the command that ran, because a single command exposes no argv to look at,
// and because `cat` of a patch file deserves the same treatment. Each marker
// is one a real diff emits and ordinary text does not, so a source file full
// of `+` bullets or `---` rules stays plain.

import { styleText } from 'node:util'

const UNIFIED_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u
const CONTEXT_FENCE = /^\*{15}$/u
const NORMAL_COMMAND = /^\d+(?:,\d+)?[acd]\d+(?:,\d+)?$/u

// Longest prefix first, so `---` is read as a file header rather than a
// removed line, and `+++` before `+`.
const UNIFIED = [
  [/^--- /u, 'bold'], [/^\+\+\+ /u, 'bold'], [UNIFIED_HUNK, 'cyan'],
  [/^\+/u, 'green'], [/^-/u, 'red'], [/^\\ /u, 'gray'],
]
const CONTEXT = [
  [CONTEXT_FENCE, 'cyan'], [/^\*{3} \d/u, 'cyan'], [/^--- \d/u, 'cyan'],
  [/^\*{3} /u, 'bold'], [/^--- /u, 'bold'],
  [/^! /u, 'yellow'], [/^\+ /u, 'green'], [/^- /u, 'red'],
]
const NORMAL = [
  [NORMAL_COMMAND, 'cyan'], [/^< /u, 'red'], [/^> /u, 'green'], [/^---$/u, 'gray'],
]

function rulesFor(lines) {
  // Context diffs also carry `---` headers, so the fence is checked first.
  if (lines.some((line) => CONTEXT_FENCE.test(line))) return CONTEXT
  if (lines.some((line) => UNIFIED_HUNK.test(line))) return UNIFIED
  if (lines.some((line) => NORMAL_COMMAND.test(line))) return NORMAL
  return null
}

export function colorizeDiff(text, stream) {
  if (text === '') return text
  const lines = text.split('\n')
  const rules = rulesFor(lines)
  if (!rules) return text
  return lines.map((line) => {
    const style = rules.find(([pattern]) => pattern.test(line))?.[1]
    // styleText leaves the text alone when the stream is not a terminal, so a
    // redirected or piped session still reads as plain diff output.
    return style ? styleText(style, line, { stream }) : line
  }).join('\n')
}
