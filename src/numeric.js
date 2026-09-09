// Integer ranges used by command syntax. Keep 64-bit bounds exact as BigInts.
export const INT32_MAX = 0x7FFF_FFFF
export const INT32_MIN = -INT32_MAX - 1
export const UINT32_MAX = 0xFFFF_FFFF
export const INT64_MAX = (1n << 63n) - 1n
export const INT64_MIN = -INT64_MAX - 1n
export const UINT64_MAX = (1n << 64n) - 1n
