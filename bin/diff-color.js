// Colours diff output in the development REPL. Not part of the published
// package: the library returns plain text, and only this REPL paints it.
//
// Which style a piece of text is written in, and what part each of its
// lines plays, is @preventive/diff/color.js's answer — read from the text's
// own structural markers rather than from the command that ran, because a
// single command exposes no argv to look at, and because `cat` of a patch
// file deserves the same treatment. All that is left here is the painting,
// which needs a stream and so cannot be the library's.

import { styleText } from 'node:util'
import { diffLineStyles } from '@preventive/diff/color.js'

export function colorizeDiff(text, stream) {
  const styles = diffLineStyles(text)
  // Null for text that is not a diff: hand it back without walking it.
  if (styles === null) return text
  // styleText leaves the text alone when the stream is not a terminal, so a
  // redirected or piped session still reads as plain diff output.
  return text.split('\n').map((line, i) => styles[i] === null ? line : styleText(styles[i], line, { stream })).join('\n')
}
