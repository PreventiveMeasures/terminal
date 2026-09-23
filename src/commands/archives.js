// The archivers: tar, over @preventive/archive's tar half, with gzip through
// the runtime's streams where it is asked for; zip and unzip, over its zip
// half, which deflates and inflates through them too — so they are here only
// where the runtime's streams know raw deflate, and not at all where they
// do not, as the compressors are.
import { supports } from '@preventive/archive/compression.js'
import { tar } from './tar/index.js'
import { unzip } from './unzip/index.js'
import { zip } from './zip.js'

export const ARCHIVE_COMMANDS = { tar, ...(supports('deflate-raw') ? { zip, unzip } : {}) }
