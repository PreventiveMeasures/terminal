#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# The web container ships Node 22 on PATH by default. This switches the
# session to the Node.js version pinned in .nvmrc (currently 24) via nvm,
# persists that PATH for every later shell command, and installs the dev
# dependencies so `node --run lint` and `node --run test` work right away.
set -euo pipefail

# Only run in remote (Claude Code on the web) sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
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

echo "Node $(node --version) from $NODE_BIN, pnpm $(pnpm --version)"
