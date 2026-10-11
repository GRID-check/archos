#!/usr/bin/env bash
# Mark a finished deploy on PostHog's charts: a project annotation "deploy <env> <sha>".
#
# Usage: posthog-annotate.sh <env> <ref>
#   env  the stack that was deployed (dev, prod)
#   ref  what it now runs: `sha-<40 hex>` (the image tag), a bare sha, or a
#        release tag such as v1.2.0
#
# Needs POSTHOG_API_KEY (a personal API key with `annotation:write`) and
# POSTHOG_PROJECT_ID. Optional: POSTHOG_CLI_HOST, the PostHog app host (default
# the EU cloud, https://eu.posthog.com; the ingestion host is not it).
#
# Why. Error tracking and the self-driving inbox date a regression by asking
# "what shipped just before the first exception". The release on an exception
# says which commit BUILT the frontend image; this says when the cluster started
# RUNNING a commit, which is the moment users saw it. Annotations also show on
# every insight, so a step in a chart lines up with a deploy without anyone
# asking.
#
# Without a key or a project id it prints one line and exits 0, so a fork and a
# repository that has not set PostHog up deploy exactly as before. The workflow
# runs it after `pulumi up` with `continue-on-error`: a PostHog outage must never
# turn a finished deploy red.
set -euo pipefail

env_name="${1:?env}"
ref="${2:?ref}"

if [ -z "${POSTHOG_API_KEY:-}" ] || [ -z "${POSTHOG_PROJECT_ID:-}" ]; then
  echo "PostHog annotation: no key or project id configured, skipping"
  exit 0
fi

# The body is assembled by hand (no jq on every runner), so both words are
# restricted to characters that need no JSON escaping.
case "$env_name" in
  *[!a-z]*|'') echo "::error::refusing env '$env_name': expected lowercase letters" >&2; exit 1 ;;
esac
ref="${ref#sha-}"
case "$ref" in
  *[!A-Za-z0-9._-]*|'') echo "::error::refusing ref '$ref': expected a sha or a release tag" >&2; exit 1 ;;
esac
case "${POSTHOG_PROJECT_ID}" in
  *[!0-9]*) echo "::error::POSTHOG_PROJECT_ID must be numeric" >&2; exit 1 ;;
esac

host="${POSTHOG_CLI_HOST:-https://eu.posthog.com}"
host="${host%/}"
marker="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
body="$(printf '{"content":"deploy %s %s","date_marker":"%s","scope":"project"}' "$env_name" "$ref" "$marker")"

curl --fail-with-body --silent --show-error --max-time 20 \
  --request POST \
  --header "Authorization: Bearer ${POSTHOG_API_KEY}" \
  --header "Content-Type: application/json" \
  --data "$body" \
  "$host/api/projects/${POSTHOG_PROJECT_ID}/annotations/" >/dev/null

echo "PostHog annotation created: deploy $env_name $ref"
