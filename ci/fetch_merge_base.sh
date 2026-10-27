#!/usr/bin/env bash
# Deepen a shallow pull-request checkout until the PR head and its base share a
# merge base, and no further.
#
# Repo checks used to clone the whole history (about 75 s of every PR's
# critical path, docs/audit/blast-radius-2026-10.md §7) for three readers that
# need only base..HEAD: the release-note rule diffs against the merge base, and
# gitleaks reads the commits the PR adds. A PR rarely sits more than a few
# hundred commits off its base, so deepening in steps fetches a few MB instead
# of 1.1 GB.
#
# Usage: ci/fetch_merge_base.sh <base sha> <head sha>
# Fails when no merge base exists even after a full unshallow, so a step that
# needs one never falls back to a two-dot diff of the whole base silently.
#
# The checkout persists no token; source ci/git_auth.sh first.
set -euo pipefail

base="${1:?usage: ci/fetch_merge_base.sh <base sha> <head sha>}"
head="${2:?usage: ci/fetch_merge_base.sh <base sha> <head sha>}"
# The checked-out commit (a PR's merge commit) is deepened too, so that
# `base..HEAD` walks through its parents instead of stopping at the graft.
checked_out="$(git rev-parse HEAD)"

fetch() {
  git fetch --no-tags --quiet origin "$@" "$base" "$head" "$checked_out"
}

fetch --depth=1
for step in 32 128 512 2048; do
  if git merge-base "$base" "$head" >/dev/null 2>&1; then
    echo "merge base $(git merge-base "$base" "$head") found ($(git rev-list --count HEAD) commits fetched)"
    exit 0
  fi
  fetch --deepen="$step"
done

echo "no merge base within the deepened history; fetching all of it"
git fetch --no-tags --quiet --unshallow origin
merge_base="$(git merge-base "$base" "$head")" || {
  echo "::error::$head shares no merge base with $base" >&2
  exit 1
}
echo "merge base $merge_base found after a full fetch"
