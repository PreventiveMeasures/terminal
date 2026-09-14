import { BindingMap } from './bindings.js'

// Variables are shell state, so a terminal's first set of bindings comes from
// here alongside the scoping that saves and restores them.
export { BindingMap }

// Shell state is private to subshells; stdin consumption and diagnostics
// still belong to the enclosing execution.
export function isolated(ctx, fn) {
  return withState(ctx, { cwd: ctx.cwd, lastExit: ctx.lastExit, vars: new BindingMap(ctx.vars), functions: new Map(ctx.functions), loopDepth: 0 }, fn)
}

// Restore exactly the scoped fields, including when nested execution throws.
export function withState(ctx, state, fn) {
  const saved = Object.fromEntries(Object.keys(state).map((key) => [key, ctx[key]]))
  Object.assign(ctx, state)
  try { return fn() } finally { Object.assign(ctx, saved) }
}
