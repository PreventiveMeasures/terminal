// A descriptor the /tmp overlay (writable.js) opens holds a file rather than
// a name, as the kernel's does: a cell, whose bytes are where `path` says
// while a name leads to them, and its own, `detached`, once none does.

import { encodeUtf8 } from './util.js'

// The bytes a cell's file holds: the tree's while a name leads to them, and
// its own once none does.
export const cellBytes = (vfs, cell) => cell.detached ?? vfs.readFile(cell.path)

// A descriptor's writes: at its offset, or at the end for one opened to
// append. A write at the end is an append, which the tree does in amortized
// linear time, so commands writing one record at a time stay linear; one
// anywhere else rewrites the file with those bytes in place, since bytes the
// tree has handed out are never written into. A file past its last name is
// the cell's to grow the same way.
export function writeHandle(vfs, path, cell, append, check) {
  let offset = 0
  const store = (bytes) => {
    const current = cellBytes(vfs, cell)
    const start = append ? current.length : offset
    if (cell.detached !== undefined) cell.detached = written(current, start, bytes)
    else if (start === current.length) vfs.appendFile(cell.path, bytes)
    else vfs.writeFile(cell.path, written(current, start, bytes))
    offset = start + bytes.length
  }
  return {
    path,
    identity: cell,
    get position() { return append ? cellBytes(vfs, cell).length : offset },
    write(text) {
      if (text === '') return
      check()
      store(encodeUtf8(text))
    },
    writeBytes(bytes) {
      if (bytes.length === 0) return
      check()
      store(bytes)
    },
  }
}

// `bytes` written into `current` at `start`: past its end into room a
// previous write left, and anywhere else into a copy, so what a reader was
// handed before is never changed under it. A gap before `start` is zeros.
function written(current, start, bytes) {
  const length = Math.max(current.length, start + bytes.length)
  const room = start === current.length && current.byteOffset + length <= current.buffer.byteLength
  const next = room ? new Uint8Array(current.buffer, current.byteOffset, length) : new Uint8Array(Math.max(length, current.length * 2)).subarray(0, length)
  if (!room) next.set(current)
  next.set(bytes, start)
  return next
}
