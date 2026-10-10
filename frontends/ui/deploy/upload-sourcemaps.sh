#!/bin/sh
# Inject PostHog chunk ids into the built UI, upload its source maps, and make
# sure no source map is left in what the image will serve.
#
# Runs inside the image build (deploy/Dockerfile, builder stage), after
# `next build` and before the runner stage copies `.next`. It has to be there:
# the injection edits the shipped JavaScript (a `//# chunkId=` comment and a
# release id), so it must happen to the very files that end up in the image.
# Injecting in a later CI step would change files the image never contained.
#
# Usage: upload-sourcemaps.sh [DIR]      DIR defaults to .next
#
# Inputs:
#   POSTHOG_PROJECT_ID    the PostHog project; empty means "do not upload"
#   /run/secrets/posthog_cli_api_key
#                         a BuildKit secret mount holding a personal API key
#                         with `error_tracking:write` and `organization:read`.
#                         A secret, never a build arg: build args are written
#                         into the image history.
#   GRID_GIT_SHA          the commit being built; becomes the release version,
#                         so it equals the `GRID_GIT_SHA` the running container
#                         reports (the runner stage declares the same arg)
#
# Optional: POSTHOG_RELEASE_NAME (default grid-ui), POSTHOG_CLI_HOST (default
# the EU app host, https://eu.posthog.com), POSTHOG_CLI_VERSION,
# POSTHOG_API_KEY_FILE (tests only).
#
# Without a project id or a key it uploads nothing, so a fork, a pull request
# and a local `docker build` all pass.
#
# Source maps are served by Next from `.next/static` the moment they exist, i.e.
# to anyone, with the original source in them. Next emits some even without
# `productionBrowserSourceMaps` (a Turbopack chunk did, found by this script's
# first CI run), so every path ends by deleting whatever map is left in the
# served trees, uploaded or not, and then checks that none survived.
# `--delete-after` removes the uploaded ones first; the prune catches the rest.
set -eu

dir="${1:-.next}"
key_file="${POSTHOG_API_KEY_FILE:-/run/secrets/posthog_cli_api_key}"
cli_version="${POSTHOG_CLI_VERSION:-0.18.8}"
host="${POSTHOG_CLI_HOST:-https://eu.posthog.com}"
release_name="${POSTHOG_RELEASE_NAME:-grid-ui}"
project_id="${POSTHOG_PROJECT_ID:-}"
sha="${GRID_GIT_SHA:-}"

# Only these two trees are ever served or loaded; `.next/cache` is build state.
served_dirs="$dir/static $dir/server"

prune_maps() {
  for tree in $served_dirs; do
    [ -d "$tree" ] || continue
    find "$tree" -name '*.map' -type f -exec rm -f {} +
  done
}

assert_no_maps() {
  leftover=""
  for tree in $served_dirs; do
    [ -d "$tree" ] || continue
    found="$(find "$tree" -name '*.map' | head -n 5)"
    [ -z "$found" ] || leftover="$leftover$found
"
  done
  if [ -n "$leftover" ]; then
    echo "error: source maps remain under $dir and would ship:" >&2
    printf '%s' "$leftover" >&2
    exit 1
  fi
}

if [ -z "$project_id" ] || [ ! -s "$key_file" ]; then
  echo "PostHog source maps: no project id or no key, nothing to upload"
  prune_maps
  assert_no_maps
  exit 0
fi

if [ -z "$sha" ]; then
  echo "error: GRID_GIT_SHA is empty; a release needs the commit it was built from" >&2
  exit 1
fi

if ! command -v posthog-cli >/dev/null 2>&1; then
  npm install --global "@posthog/cli@$cli_version"
fi

POSTHOG_CLI_API_KEY="$(cat "$key_file")"
POSTHOG_CLI_PROJECT_ID="$project_id"
export POSTHOG_CLI_API_KEY POSTHOG_CLI_PROJECT_ID

# `.next/cache` holds build state, not output: it can carry copies of chunks
# whose maps are not ours to upload.
posthog-cli --host "$host" sourcemap process \
  --directory "$dir" \
  --exclude "$dir/cache/**" \
  --release-name "$release_name" \
  --release-version "$sha" \
  --delete-after

prune_maps
assert_no_maps

# The injection is what ties a stack frame to the uploaded map. If it did
# nothing, the upload above was for nothing, and this is the cheapest place to
# say so.
if ! grep -rlq 'chunkId=' --include='*.js' "$dir/static"; then
  echo "error: no chunk id was injected under $dir/static; PostHog could not match any stack frame" >&2
  exit 1
fi
echo "PostHog source maps: uploaded for release $release_name@$sha"
