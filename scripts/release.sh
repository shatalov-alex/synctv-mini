#!/usr/bin/env bash
# Publish a SyncTV Mini release: run the full local CI, tag main, push, and create the
# GitHub release with the matching CHANGELOG section as its notes.
#
#   scripts/release.sh 1.0.1        (or: make release VERSION=1.0.1)
#
# Set SKIP_CI=1 only if `make ci-full` already passed on this exact commit.
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 X.Y.Z" >&2
  exit 2
fi
tag="mini-v$version"
cd "$(git rev-parse --show-toplevel)"

[[ "$(git branch --show-current)" == main ]] || { echo "Release from main." >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "The working tree has changes; commit or stash them." >&2; exit 1; }
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "$tag already exists." >&2; exit 1; }

# gh picks the parent repository for a fork, so name ours explicitly (owner/name from origin).
repo="$(git remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
[[ "$repo" =~ ^[^/]+/[^/]+$ ]] || { echo "Can't read owner/name from origin: $repo" >&2; exit 1; }

notes="$(awk -v v="$version" '
  $0 ~ "^## \\[" v "\\]" { on = 1; next }
  on && /^## \[/ { exit }
  on && /^\[[^]]+\]: / { exit }
  on { print }
' CHANGELOG.md)"
[[ -n "${notes//[[:space:]]/}" ]] || { echo "CHANGELOG.md has no '## [$version]' section." >&2; exit 1; }

if [[ "${SKIP_CI:-}" != 1 ]]; then
  echo "== make ci-full"
  make ci-full
fi

echo "== tagging $tag"
git tag -a "$tag" -m "SyncTV Mini $version"
git push origin main "refs/tags/$tag"

echo "== creating the GitHub release"
gh release create "$tag" -R "$repo" --verify-tag --title "SyncTV Mini $version" --notes "$notes"
