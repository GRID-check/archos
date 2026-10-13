#!/usr/bin/env bash
# Print the manifest digest GHCR serves for grid-oib-<service>:<tag>.
#
# Usage: image-digest.sh <owner> <service> <tag>
# Needs GITHUB_ACTOR and GH_TOKEN (a token with `packages: read`).
#
# Exit status is the contract of find-published-tag.sh beside this:
#   0  the digest (sha256:<hex>) is printed on stdout
#   1  the tag is not published (404)
#   2  the registry did not answer, or answered without a digest
#
# The digest is what the kubelet resolves the tag to, so two tags with one
# digest are one image. CI's publish copies the same `inputs-<hash>` manifest
# under every commit that did not rebuild an image, and `resolve-image-refs.sh`
# asks this to tell those re-tags from a new build.
set -euo pipefail

owner="$(printf '%s' "${1:?owner}" | tr '[:upper:]' '[:lower:]')"
service="${2:?service}"
tag="${3:?tag}"

image_path="${owner}/grid-oib-${service}"
pull_token="$(curl -sSL -u "${GITHUB_ACTOR}:${GH_TOKEN}" \
  "https://ghcr.io/token?service=ghcr.io&scope=repository:${image_path}:pull" \
  | jq -r '.token // empty' || true)"
[ -n "$pull_token" ] || {
  echo "::error::could not obtain a GHCR pull token for ${image_path} — the job token needs 'packages: read'." >&2
  exit 2
}

# The same Accept list as find-published-tag.sh, index first: asked the same
# way, every tag of one manifest answers the same digest.
response="$(curl -sSL -o /dev/null -D - -w '%{http_code}\n' --head \
  -H "Authorization: Bearer ${pull_token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
  "https://ghcr.io/v2/${image_path}/manifests/${tag}" || echo 000)"
status="$(printf '%s\n' "$response" | tail -n 1)"
case "$status" in
  200) ;;
  404) exit 1 ;;
  *)
    echo "::error::GHCR answered HTTP ${status} for ${image_path}:${tag}; cannot read its digest." >&2
    exit 2
    ;;
esac

digest="$(printf '%s\n' "$response" | tr -d '\r' \
  | awk 'tolower($1) == "docker-content-digest:" { d = $2 } END { print d }')"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "::error::GHCR answered ${image_path}:${tag} without a digest." >&2
  exit 2
}
printf '%s\n' "$digest"
