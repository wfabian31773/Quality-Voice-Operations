#!/usr/bin/env bash
# scripts/fix-git-state.sh
#
# Recovery script for the stuck-rebase + polluted-remotes situation
# diagnosed on 2026-05-26. Safe to run from the Replit shell, your
# local clone, or any shell with this repo checked out. Idempotent.
#
# What it does, in order:
#   1. Confirms there is no rebase in progress (aborts gracefully if there is).
#   2. Removes the stale .git/refs/remotes/origin/HEAD.lock file if present.
#   3. Tags the current HEAD as a safety backup before any history rewriting.
#   4. Fetches origin/main.
#   5. Rebases local main onto origin/main, with merge-strategy "theirs" for
#      the 3 known-conflicting admin panel files (the local version is the
#      one we want — upstream's "FIX CI green" only touched i18n keys, but
#      our 6aa06a76 commit added imports those files actually need).
#   6. Pushes with --force-with-lease (aborts if origin moved again).
#   7. Removes all 894 polluted subrepl-* remotes, keeping only origin
#      and gitsafe-backup.
#   8. Prints final state for verification.
#
# Run from repo root:
#   bash scripts/fix-git-state.sh

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "==> Step 1: Check for in-progress rebase / merge"
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  echo "    Found in-progress rebase. Aborting it first."
  git rebase --abort || true
fi
if [ -f .git/MERGE_HEAD ]; then
  echo "    Found in-progress merge. Aborting it first."
  git merge --abort || true
fi

echo "==> Step 2: Remove stale origin/HEAD.lock if present"
if [ -f .git/refs/remotes/origin/HEAD.lock ]; then
  rm -f .git/refs/remotes/origin/HEAD.lock
  echo "    Removed."
else
  echo "    No stale lock — nothing to do."
fi

echo "==> Step 3: Create safety backup tag"
SAFETY_TAG="pre-rebase-cleanup-$(date +%Y%m%d-%H%M%S)"
git tag -f "$SAFETY_TAG" HEAD
echo "    Tagged HEAD as $SAFETY_TAG"

echo "==> Step 4: Fetch origin/main"
git fetch origin main

echo "==> Step 5: Rebase onto origin/main"
echo "    Local HEAD:  $(git rev-parse --short HEAD)"
echo "    origin/main: $(git rev-parse --short origin/main)"

CONFLICT_FILES=(
  "client-app/src/pages/admin/dashboard/panels/ActivationMetricsTab.tsx"
  "client-app/src/pages/admin/dashboard/panels/DocsFeedbackTab.tsx"
  "client-app/src/pages/admin/dashboard/panels/TemplateAnalyticsTab.tsx"
)

# Rebase, auto-resolving the 3 known panel files in favor of OUR version
# (which contains the import fixes that 6aa06a76 added).
if ! git rebase origin/main; then
  echo "    Rebase paused with conflicts — auto-resolving the known 3 panel files."
  while [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; do
    # Take OUR version of the 3 panel files
    for f in "${CONFLICT_FILES[@]}"; do
      if git --no-optional-locks status --porcelain "$f" 2>/dev/null | grep -q '^UU'; then
        echo "    Taking OUR version of: $f"
        git checkout --ours -- "$f"
        git add "$f"
      fi
    done
    # If there are still other unresolved conflicts, bail out for manual fix
    if git --no-optional-locks diff --name-only --diff-filter=U | grep -q .; then
      echo "    ERROR: Unexpected conflicts in files other than the 3 panels:"
      git --no-optional-locks diff --name-only --diff-filter=U
      echo "    Resolve those manually, then run: git rebase --continue && bash scripts/fix-git-state.sh"
      exit 1
    fi
    # Continue the rebase. May stop again on the next commit with the same conflicts.
    GIT_EDITOR=true git rebase --continue || {
      # If it's an empty commit (the "Published your App" entries), skip it
      if git --no-optional-locks status | grep -q "nothing to commit"; then
        git rebase --skip
      else
        break
      fi
    }
  done
fi

echo "==> Step 6: Push with --force-with-lease"
git push origin main --force-with-lease

echo "==> Step 7: Prune polluted subrepl-* remotes"
PRUNE_COUNT=$(git remote | grep -c '^subrepl-' || true)
echo "    Found $PRUNE_COUNT subrepl-* remotes to remove."
git remote | grep '^subrepl-' | while read -r r; do
  git remote remove "$r" || true
done
echo "    Done. Remaining remotes:"
git remote | sed 's/^/      /'

echo "==> Step 8: Final state"
echo "    git status:"
git --no-optional-locks status | head -5
echo ""
echo "    Last 5 commits on main:"
git --no-optional-locks log --oneline -5
echo ""
echo "    Safety backup tag: $SAFETY_TAG"
echo "    (If anything looks wrong, recover with:  git reset --hard $SAFETY_TAG)"
echo ""
echo "==> All done."
