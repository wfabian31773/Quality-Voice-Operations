#!/usr/bin/env bash
# Install repo-tracked git hooks into .git/hooks/ via symlink.
#
# Run once after cloning:
#   bash scripts/git-hooks/install.sh
#
# Why symlink (not copy):
#   - Edits to scripts/git-hooks/* take effect immediately for everyone
#     who's run install.sh once. No "I'm running an old hook" drift.
#   - Removing the hook is `rm .git/hooks/pre-push` — no other state.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="$REPO_ROOT/scripts/git-hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

if [[ ! -d "$HOOKS_DST" ]]; then
  echo "error: $HOOKS_DST doesn't exist — are you in a git repo?" >&2
  exit 1
fi

installed=0
for hook in pre-push pre-commit commit-msg; do
  src="$HOOKS_SRC/$hook"
  dst="$HOOKS_DST/$hook"
  if [[ ! -f "$src" ]]; then
    continue
  fi

  # Already-installed sanity check.
  if [[ -L "$dst" ]]; then
    current_target="$(readlink "$dst")"
    expected="../../scripts/git-hooks/$hook"
    if [[ "$current_target" == "$expected" ]]; then
      echo "[install] $hook already linked"
      installed=$((installed + 1))
      continue
    fi
    echo "[install] $hook points to $current_target, replacing"
    rm "$dst"
  elif [[ -e "$dst" ]]; then
    # Real file — back it up so we don't silently nuke a custom hook.
    backup="$dst.local.bak.$(date +%s)"
    mv "$dst" "$backup"
    echo "[install] backed up existing $hook to $(basename "$backup")"
  fi

  chmod +x "$src"
  ln -s "../../scripts/git-hooks/$hook" "$dst"
  echo "[install] linked $hook"
  installed=$((installed + 1))
done

if [[ "$installed" -eq 0 ]]; then
  echo "[install] no hooks found in $HOOKS_SRC"
  exit 1
fi

echo
echo "Done. To bypass a hook for a single push, set SKIP_TSC_HOOK=1 or use --no-verify."
