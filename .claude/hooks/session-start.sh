#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# The web container ships Node 22 on PATH by default. This switches the
# session to the Node.js version pinned in .nvmrc (currently 24) via nvm,
# persists that PATH for every later shell command, and installs the dev
# dependencies so `node --run lint` and `node --run test` work right away.
# When Claude works in a worktree of this repository, that worktree is set
# up instead of the main checkout.
set -euo pipefail

# Only run in remote (Claude Code on the web) sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# SessionStart stdout is added to Claude's context, so the nvm, corepack
# and pnpm logs go to stderr. Only the closing summary line is written to
# the original stdout, kept on fd 3.
exec 3>&1 1>&2

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# CLAUDE_PROJECT_DIR stays at the checkout the session started in, while
# the hook input's cwd follows Claude into a worktree. Set that worktree
# up instead when it belongs to the same repository, so it gets its own
# node_modules and nvm reads its .nvmrc. There may be no node to parse the
# input with yet, so cwd is matched with a regex; one holding `"` or `\`,
# like another repo, a non-git cwd or no input, keeps the project dir.
cwd_re='"cwd"[[:space:]]*:[[:space:]]*"([^"\]*)"'
if [ ! -t 0 ] && [[ "$(cat)" =~ $cwd_re ]]; then
  HOOK_CWD="${BASH_REMATCH[1]}"
  git_common_dir() { git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; }
  if WORKTREE="$(git -C "$HOOK_CWD" rev-parse --show-toplevel 2>/dev/null)" &&
    [ "$(git_common_dir "$WORKTREE")" = "$(git_common_dir "$PROJECT_DIR")" ]; then
    PROJECT_DIR="$WORKTREE"
  fi
fi

cd "$PROJECT_DIR"

export NVM_DIR="${NVM_DIR:-/opt/nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "nvm not found at $NVM_DIR; staying on $(node --version)" >&2
  exit 0
fi

# nvm.sh is not clean under `set -u`.
set +u
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" --no-use
# Reads .nvmrc. Idempotent: a no-op when that version is already installed.
nvm install --no-progress
nvm use --silent
set -u

NODE_BIN="$(dirname "$(command -v node)")"

# Persist the Node version for the rest of the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export NVM_DIR=\"$NVM_DIR\""
    echo "export PATH=\"$NODE_BIN:\$PATH\""
  } >> "$CLAUDE_ENV_FILE"
fi

# pnpm: the version is pinned by "packageManager" in package.json, so let
# corepack provide it. Fall back to a global npm install if corepack is
# unavailable in this Node build.
if command -v corepack >/dev/null 2>&1; then
  corepack enable --install-directory "$NODE_BIN"
else
  npm install -g pnpm
fi

pnpm install --frozen-lockfile

echo "Node $(node --version) from $NODE_BIN, pnpm $(pnpm --version) in $PROJECT_DIR" >&3
