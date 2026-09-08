import { UnsupportedError } from './unsupported.js'

const UNMODELED = new Set(['CDPATH', 'GLOBIGNORE', 'GLOBSORT', 'BASH_COMPAT', 'POSIXLY_CORRECT', 'PATH', 'RANDOM', 'SRANDOM', 'SECONDS', 'EPOCHSECONDS', 'EPOCHREALTIME', 'BASHOPTS', 'SHELLOPTS', 'OPTIND'])

// Track explicit absence as well as values. An unset variable is known to be
// empty, whereas an unknown environment name still needs a diagnostic.
export class BindingMap extends Map {
  constructor(other) {
    super(other)
    this.unsetNames = new Set(other?.unsetNames)
  }

  set(name, value) {
    if (UNMODELED.has(name) || (name === 'TZ' && !['UTC', 'UTC0', ''].includes(value)) || ((name === 'LANG' || name.startsWith('LC_')) && !['C', 'POSIX', ''].includes(value))) {
      throw new UnsupportedError('feature', name, `shell variable ${name} is not supported with this value`)
    }
    this.bound?.add(name)
    this.unsetNames?.delete(name)
    return super.set(name, value)
  }

  delete(name) {
    this.unsetNames.add(name)
    return super.delete(name)
  }
}
