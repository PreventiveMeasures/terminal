// Alias expansion is unavailable, but an alias may supply grammar tokens that
// explain a later parse failure. Definitions become candidates only after a
// complete top-level input unit, as in Bash's parse-then-execute cycle.
export function advanceAliases(steps, aliases, hasCommand) {
  const state = { aliases: new Set(aliases), hasCommand }
  inspect(steps, state)
  return state.aliases
}

const union = (a, b) => new Set([...a, ...b])

function inspect(steps, state) {
  let status = null
  for (const step of steps) {
    const gated = step.gate === 'and' || step.gate === 'or'
    if (gated && status !== null && (step.gate === 'and') !== (status === 0)) continue
    const before = gated && status === null ? new Set(state.aliases) : null
    const stage = step.stages.length === 1 ? step.stages[0] : null
    status = stage && !stage.isolate ? inspectStage(stage, state) : null
    if (step.negate && status !== null) status = Number(status === 0)
    if (before) {
      state.aliases = union(before, state.aliases)
      status = null
    }
  }
  return status
}

function inspectStage(stage, state) {
  if (stage.group) return inspect(stage.group, state)
  if (stage.conditional) return conditional(stage.conditional, state)
  if (stage.loop) {
    if (stage.loop.words.length > 1) {
      const before = new Set(state.aliases)
      inspect(stage.loop.body, state)
      state.aliases = union(before, state.aliases)
    }
    return null
  }
  const name = stage.words[0]?.value
  if (stage.redirs.length === 0 && (name === 'true' || name === 'false')) return Number(name === 'false')
  if (!['alias', 'unalias'].includes(name) || state.hasCommand(name)) return null
  const args = stage.words.slice(1).map((w) => w.value)
  while (args[0]?.startsWith('-') && args[0] !== '-') {
    const option = args.shift()
    if (option === '--') break
    if (!(name === 'alias' ? /^-p+$/u : /^-a+$/u).test(option)) return null
    if (name === 'unalias') { state.aliases.clear(); return null }
  }
  for (const value of args) {
    if (name === 'unalias') state.aliases.delete(value)
    else {
      const eq = value.indexOf('=')
      const alias = value.slice(0, eq)
      if (eq > 0 && !/[ \t\n/$`=;'"\\|&()<>]/u.test(alias)) state.aliases.add(alias)
    }
  }
  return null
}

function conditional(command, state) {
  let possible = new Set()
  for (const branch of command.branches) {
    const status = inspect(branch.condition, state)
    if (status === 0) { inspect(branch.body, state); state.aliases = union(possible, state.aliases); return null }
    if (status === null) {
      const body = { ...state, aliases: new Set(state.aliases) }
      inspect(branch.body, body)
      possible = union(possible, body.aliases)
    }
  }
  if (command.otherwise) inspect(command.otherwise, state)
  state.aliases = union(possible, state.aliases)
  return null
}
