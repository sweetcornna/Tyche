#!/usr/bin/env bash
# Create a local development environment for Tyche on top of the JiuwenSwarm fork.
#
# The upstream lockfile pins openjiuwen (agent-core) and intelli-router
# (agent-protocol) to exact commits on gitcode.com. When gitcode is not
# reachable, the identical commits are installed from the official GitHub
# mirrors under github.com/openJiuwen-ai instead. The pinned SHAs never change.
#
# Usage: scripts/tyche/install_dev.sh [--python 3.11] [--venv .venv]
set -euo pipefail

PYTHON_VERSION="3.11"
VENV_DIR=".venv"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --python) PYTHON_VERSION="$2"; shift 2 ;;
    --venv) VENV_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v uv >/dev/null || { echo "uv is required: https://docs.astral.sh/uv/" >&2; exit 1; }

REQS="$(mktemp -t tyche-reqs.XXXXXX.txt)"
trap 'rm -f "$REQS"' EXIT
uv export --frozen --no-hashes --no-emit-project --extra test > "$REQS"

if timeout 20 git ls-remote https://gitcode.com/openJiuwen/agent-core.git HEAD >/dev/null 2>&1; then
  echo "[tyche] gitcode.com reachable; using upstream pins as-is"
else
  echo "[tyche] gitcode.com unreachable; using GitHub mirrors of the same commits"
  sed -i.bak \
    -e 's#git+https://gitcode.com/openJiuwen/agent-core.git@#git+https://github.com/openJiuwen-ai/agent-core.git@#' \
    -e 's#git+https://gitcode.com/openJiuwen/agent-protocol.git@#git+https://github.com/openJiuwen-ai/agent-protocol.git@#' \
    "$REQS"
  rm -f "$REQS.bak"
fi

if grep -q "gitcode.com" "$REQS" && ! timeout 20 git ls-remote https://gitcode.com/openJiuwen/agent-core.git HEAD >/dev/null 2>&1; then
  echo "[tyche] unresolved gitcode requirement remains:" >&2
  grep "gitcode.com" "$REQS" >&2
  exit 1
fi

[[ -d "$VENV_DIR" ]] || uv venv "$VENV_DIR" --python "$PYTHON_VERSION"
export VIRTUAL_ENV="$ROOT/$VENV_DIR"
export GIT_LFS_SKIP_SMUDGE=1
# The export already lists every transitive pin, so install it without
# re-resolving: openjiuwen's own metadata names intelli-router by a gitcode
# branch, which would bypass the mirror rewrite above.
uv pip install --no-deps -r "$REQS"
uv pip install --no-deps -e .
uv pip install "ruff>=0.11.2"

# openjiuwen's experiment coding agent reads the SDK reference docs from
# <site-packages>/docs (agent-core's docs/ tree), which a pip install does not ship.
# Fetch exactly the pinned commit's docs/ so generated experiment code is grounded.
SITE="$("$VENV_DIR/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
if [[ ! -d "$SITE/docs/en" ]]; then
  PIN="$(grep -o 'agent-core.git@[0-9a-f]\{40\}' pyproject.toml | head -1 | cut -d@ -f2)"
  DOCS_TMP="$(mktemp -d -t tyche-agentcore-docs.XXXXXX)"
  for REMOTE in https://gitcode.com/openJiuwen/agent-core.git https://github.com/openJiuwen-ai/agent-core.git; do
    if git -C "$DOCS_TMP" init -q 2>/dev/null \
      && git -C "$DOCS_TMP" remote add origin "$REMOTE" 2>/dev/null \
      && timeout 300 git -C "$DOCS_TMP" fetch -q --depth 1 --filter=blob:none origin "$PIN" \
      && git -C "$DOCS_TMP" sparse-checkout set docs \
      && git -C "$DOCS_TMP" checkout -q FETCH_HEAD; then
      rm -rf "$SITE/docs" && mv "$DOCS_TMP/docs" "$SITE/docs"
      echo "[tyche] installed openjiuwen reference docs ($PIN) from $REMOTE"
      break
    fi
    rm -rf "$DOCS_TMP" && DOCS_TMP="$(mktemp -d -t tyche-agentcore-docs.XXXXXX)"
  done
  rm -rf "$DOCS_TMP"
  [[ -d "$SITE/docs/en" ]] || echo "[tyche] warning: could not fetch openjiuwen reference docs" >&2
fi
echo "[tyche] environment ready: source $VENV_DIR/bin/activate"
