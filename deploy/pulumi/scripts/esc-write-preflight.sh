#!/usr/bin/env bash
# Can this run's Pulumi token create and delete ESC environments in the
# project the `workspace` stacks import from? (ADR-0147, "The Pulumi project
# and its config keys".) The move clones `grid-oib/<stack>` into
# `workspace/<stack>`, and a token without Environment Write there would
# otherwise be discovered by the first expand deploy, halfway through.
#
# It creates a probe environment and deletes it again: nothing else is touched.
#
#   esc-write-preflight.sh <org> [warn|fail]
#
# `warn` (the default) annotates the run and exits 0, so a missing grant does
# not stop deploys before the move needs it. The expand step switches the
# workflow to `fail`.
set -uo pipefail

org="${1:?usage: esc-write-preflight.sh <org> [warn|fail]}"
mode="${2:-warn}"
probe="${org}/workspace/preflight-probe"
need="the Pulumi token needs Environment Write on workspace/* (ADR-0147)"

refuse() {
  if [ "$mode" = "fail" ]; then
    echo "::error::${need}: $1"
    exit 1
  fi
  echo "::warning::${need}: $1"
  exit 0
}

# A run killed between create and delete leaves the probe behind.
pulumi env rm --yes "$probe" >/dev/null 2>&1 || true

if ! out="$(pulumi env init "$probe" 2>&1)"; then
  refuse "creating ${probe} was refused: ${out}"
fi
if ! out="$(pulumi env rm --yes "$probe" 2>&1)"; then
  refuse "deleting ${probe} was refused: ${out}"
fi
echo "ESC write preflight OK: created and deleted ${probe}"
