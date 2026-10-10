// A control character typed into the source as a raw byte is invisible in
// an editor and in a diff, and reads as binary to tools that scan the
// package. Every one of them can be written as an escape instead (\u0007,
// \u001B, ...), so none but tab, newline and carriage return is allowed.

const isControl = (code) => (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) || code === 0x7F

const noControlBytes = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow raw control characters in source text' },
  },
  create(context) {
    return {
      Program() {
        const { sourceCode } = context
        const { text } = sourceCode
        for (let i = 0; i < text.length; i++) {
          const code = text.codePointAt(i)
          if (!isControl(code)) continue
          const escape = `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
          context.report({
            loc: { start: sourceCode.getLocFromIndex(i), end: sourceCode.getLocFromIndex(i + 1) },
            message: `Raw control character U+${escape.slice(2)}; write it as ${escape} instead.`,
          })
        }
      },
    }
  },
}

export default {
  meta: { name: 'local' },
  rules: { 'no-control-bytes': noControlBytes },
}
