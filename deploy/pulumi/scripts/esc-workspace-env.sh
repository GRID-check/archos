#!/usr/bin/env bash
# The ESC environment of a `workspace` stack, made from the legacy one
# (ADR-0147, "The Pulumi project and its config keys"). Idempotent: each step
# runs only while its result is missing, so a re-run after a partial failure
# finishes the job and a run after success changes nothing.
#
#   esc-workspace-env.sh <org> <stack> <legacy stack file> [warn|fail]
#
#   1. clone <org>/grid-oib/<stack> into <org>/workspace/<stack>. The clone
#      re-encrypts every secret under the new environment;
#   2. rename the keys `pulumiConfig.grid-oib:*` to `pulumiConfig.workspace:*`
#      inside the clone. The definition is read and written as ciphertext,
#      which stays bound to the environment holding it, so no plaintext leaves
#      ESC;
#   3. copy the legacy stack file's `secure:` values, which only the legacy
#      stack can decrypt, into the clone: read through that stack, written with
#      `pulumi env set --secret`.
#
# Only the workspace environment is ever written. The legacy one is read.
set -uo pipefail

org="${1:?usage: esc-workspace-env.sh <org> <stack> <legacy stack file> [warn|fail]}"
stack="${2:?missing <stack>}"
legacy_file="${3:?missing <legacy stack file>}"
mode="${4:-warn}"
here="$(cd "$(dirname "$0")" && pwd)"
src="${org}/grid-oib/${stack}"
dst="${org}/workspace/${stack}"

refuse() {
  local level=warning
  [ "$mode" = "fail" ] && level=error
  echo "::${level}::ESC environment ${dst} (ADR-0147): $1"
  [ "$mode" = "fail" ] && exit 1
  exit 0
}

if ! pulumi env get "$dst" --definition >/dev/null 2>&1; then
  out="$(pulumi env clone "$src" "workspace/${stack}" 2>&1)" || refuse "cloning ${src} was refused: ${out}"
  echo "cloned ${src} into ${dst}"
fi

def="$(pulumi env get "$dst" --definition 2>&1)" || refuse "reading the definition failed: ${def}"
# The rewrite below saves the definition back. That is only safe when it
# carries the secrets as ciphertext; a redacted form would overwrite them.
if grep -qE '\[secret\]|\*\*\*\*' <<<"$def"; then
  refuse "the definition came back redacted, not as ciphertext; not rewriting it"
fi
if grep -qE '^[[:space:]]+grid-oib:' <<<"$def"; then
  out="$(sed -E 's/^([[:space:]]+)grid-oib:/\1workspace:/' <<<"$def" | pulumi env edit "$dst" --file - 2>&1)" ||
    refuse "renaming the pulumiConfig keys failed: ${out}"
  echo "renamed pulumiConfig.grid-oib:* to pulumiConfig.workspace:* in ${dst}"
fi

for key in $(node "${here}/workspace-stack-file.mjs" --secure-keys "$legacy_file"); do
  have="$(pulumi env get "$dst" "pulumiConfig.workspace:${key}" 2>/dev/null || true)"
  [ -n "$have" ] && continue
  value="$(pulumi config get "grid-oib:${key}" --stack "$src" --cwd "$(dirname "$legacy_file")" 2>/dev/null)" ||
    refuse "the legacy stack could not decrypt grid-oib:${key}"
  echo "::add-mask::${value}"
  out="$(pulumi env set "$dst" "pulumiConfig.workspace:${key}" "$value" --secret 2>&1)" ||
    refuse "writing pulumiConfig.workspace:${key} failed: ${out}"
  echo "copied the legacy stack's secure ${key} into ${dst}"
done
echo "ESC environment ${dst} is ready"
