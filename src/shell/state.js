import { BindingMap } from './bindings.js'

// Shell state is private to subshells; stdin consumption and diagnostics
// still belong to the enclosing execution.
export function isolated(ctx, fn) {
  return withState(ctx, { cwd: ctx.cwd, lastExit: ctx.lastExit, vars: new BindingMap(ctx.vars), loopDepth: 0 }, fn)
}

// Restore exactly the scoped fields, including when nested execution throws.
export function withState(ctx, state, fn) {
  const saved = Object.fromEntries(Object.keys(state).map((key) => [key, ctx[key]]))
  Object.assign(ctx, state)
  try { return fn() } finally { Object.assign(ctx, saved) }
}
