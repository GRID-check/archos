#!/usr/bin/env bash
# A throwaway Qdrant for the suites that test against a real one (ADR-0115):
# the German BM25, fusion, strict mode and group_by they assert are the
# server's behaviour, so a mock would only test the mock.
#
#   qdrant-test-server.sh --exec <command…>   start one, run the command with
#                                              AIQ_QDRANT_TEST_URL set, stop it
#   qdrant-test-server.sh --start             start one that outlives the script
#                                              and print AIQ_QDRANT_TEST_URL=<url>
#                                              (CI appends it to $GITHUB_ENV)
#
# A binary, not a container, for the same reason scripts/rls-test-db.sh runs
# Postgres from its server binaries: the same command works on a laptop, on a
# GitHub-hosted runner and on the cluster's runners (ADR-0118), and none of them
# needs a Docker daemon. The version is production's (the drift test in
# tests/test_ci_toolchain_pins.py holds the two together). The binary is found
# in $QDRANT_BIN, then in the CI runner image (/opt/qdrant/<version>), then in
# ~/.cache/grid-qdrant/<version>, and is otherwise downloaded there and checked
# against the digest below.
set -euo pipefail

QDRANT_VERSION="1.19.2"
# sha256 of the release tarball per platform, as downloaded on 2026-10-20.
# Qdrant publishes no Linux arm64 build; there, set QDRANT_BIN or run the image.
qdrant_asset() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) echo "x86_64-unknown-linux-gnu 34a788a09a4cb278b5c6d2af96d9a6db30c8c7e88ae3550455f7a4d425bb8d4b" ;;
    Darwin-arm64) echo "aarch64-apple-darwin d24dfd25f4584684b337dd30ee016472cd25f53fc2501f1cd058ab3d7ee0b019" ;;
    Darwin-x86_64) echo "x86_64-apple-darwin e095b682ad7460baff43827eaa13647b5ec97c48edcb676646ae2f4108395044" ;;
    *) return 1 ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

resolve_binary() {
  if [ -n "${QDRANT_BIN:-}" ]; then echo "$QDRANT_BIN"; return; fi
  local baked="/opt/qdrant/$QDRANT_VERSION/qdrant"
  if [ -x "$baked" ]; then echo "$baked"; return; fi
  local dir="${XDG_CACHE_HOME:-$HOME/.cache}/grid-qdrant/$QDRANT_VERSION"
  if [ -x "$dir/qdrant" ]; then echo "$dir/qdrant"; return; fi

  local asset triple digest tarball
  asset=$(qdrant_asset) || {
    echo "error: no Qdrant $QDRANT_VERSION build for $(uname -s)-$(uname -m). Set QDRANT_BIN, or run qdrant/qdrant:v$QDRANT_VERSION and set AIQ_QDRANT_TEST_URL yourself." >&2
    exit 1
  }
  triple="${asset% *}"
  digest="${asset#* }"
  mkdir -p "$dir"
  tarball="$dir/qdrant.tar.gz"
  echo "==> downloading Qdrant $QDRANT_VERSION ($triple)" >&2
  curl -fsSL -o "$tarball" "https://github.com/qdrant/qdrant/releases/download/v$QDRANT_VERSION/qdrant-$triple.tar.gz"
  if [ "$(sha256_of "$tarball")" != "$digest" ]; then
    rm -f "$tarball"
    echo "error: the Qdrant $QDRANT_VERSION download does not match its pinned sha256" >&2
    exit 1
  fi
  tar -xzf "$tarball" -C "$dir" qdrant
  rm -f "$tarball"
  echo "$dir/qdrant"
}

free_port() {
  node -e '
    const server = require("net").createServer();
    server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });
  '
}

# Start a server in <workdir>; sets QDRANT_PID and QDRANT_URL.
start_server() {
  local workdir="$1" bin http grpc
  bin=$(resolve_binary)
  http=$(free_port)
  grpc=$(free_port)
  (
    cd "$workdir"
    QDRANT__STORAGE__STORAGE_PATH="$workdir/storage" \
    QDRANT__STORAGE__SNAPSHOTS_PATH="$workdir/snapshots" \
    QDRANT__SERVICE__HOST=127.0.0.1 \
    QDRANT__SERVICE__HTTP_PORT="$http" \
    QDRANT__SERVICE__GRPC_PORT="$grpc" \
    QDRANT__TELEMETRY_DISABLED=true \
      exec "$bin" >"$workdir/qdrant.log" 2>&1
  ) &
  QDRANT_PID=$!
  QDRANT_URL="http://127.0.0.1:$http"
  local _
  for _ in $(seq 1 100); do
    if curl -fs "$QDRANT_URL/readyz" >/dev/null 2>&1; then return; fi
    if ! kill -0 "$QDRANT_PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
  echo "error: Qdrant did not become ready; its log:" >&2
  cat "$workdir/qdrant.log" >&2
  exit 1
}

case "${1:-}" in
  --exec)
    shift
    [ $# -gt 0 ] || { echo "usage: $0 --exec <command…>" >&2; exit 2; }
    WORKDIR="$(mktemp -d)"
    QDRANT_PID=""
    trap '[ -n "$QDRANT_PID" ] && kill "$QDRANT_PID" 2>/dev/null; wait 2>/dev/null; rm -rf "$WORKDIR"' EXIT
    start_server "$WORKDIR"
    echo "==> Qdrant $QDRANT_VERSION on $QDRANT_URL; running: $*" >&2
    AIQ_QDRANT_TEST_URL="$QDRANT_URL" "$@"
    ;;
  --start)
    WORKDIR="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/qdrant.XXXXXX")"
    start_server "$WORKDIR"
    disown "$QDRANT_PID" 2>/dev/null || true
    echo "AIQ_QDRANT_TEST_URL=$QDRANT_URL"
    ;;
  *)
    echo "usage: $0 --exec <command…> | --start" >&2
    exit 2
    ;;
esac
