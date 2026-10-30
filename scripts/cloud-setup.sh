#!/bin/bash
#
# Machine tools for a Claude Code cloud session, installed once per environment.
#
# WHAT THE OWNER PASTES into claude.ai > environment settings > Setup script:
#
#     bash <clone-dir>/scripts/cloud-setup.sh
#
# (the script starts in the directory ABOVE the clone; this file finds the repo
# from its own location, so any working directory works. Only the clone's
# directory name has to be right: see docs/contributing/agent-skills.md.)
#
# WHY A SECOND FILE BESIDE .claude/hooks/session-start.sh. The environment runs
# this before Claude Code starts, as root. If it finishes in about five minutes
# the container disk is snapshotted and later sessions start from the snapshot
# without running it again. That makes it the right place for the slow, global,
# network-bound tools, and the wrong place for anything that follows a lockfile:
# the snapshot is rebuilt only when this script or the allowed domains change, or
# after about a week, and never notices a changed `uv.lock` or `bun.lock`.
# Project dependencies therefore stay in the SessionStart hook, which skips them
# when their lockfile hash is unchanged.
#
# RULES THAT COME FROM RUNNING THERE:
#   - A non-zero exit stops the session from starting, so nothing optional may
#     fail the script: every step ends in `|| warn`, and the script ends 0.
#   - Network secrets are not available yet (the proxy that adds them starts
#     later), so nothing here may need a token.
#   - Bun has known trouble with the cloud proxy, so global installs use npm.
#   - No sleeps or retry loops: a hung step would eat the snapshot window.
#   - Independent installs run in parallel and are joined with `wait`.
#
# MULTI-REPO SESSIONS load no repository's .claude/settings.json, so the hook
# never runs there. Pass `--with-skills` and this script also publishes the apm
# skills (`apm install --frozen`), which covers that case from the setup line:
#
#     bash <clone-dir>/scripts/cloud-setup.sh --with-skills
#
# IDEMPOTENT: each tool is skipped when its pinned version is already present.
set -euxo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

WITH_SKILLS=false
for arg in "$@"; do
  if [ "$arg" = "--with-skills" ]; then WITH_SKILLS=true; fi
done

log() { echo "[cloud-setup] $*"; }
warn() { log "WARNING: $* (continuing; the SessionStart hook retries what it can)"; }

# One pin each, read from where the rest of the repo reads it (see the hook).
TASK_VERSION="$(awk -F'"' '/default:/ {print $2; exit}' .github/actions/setup-task/action.yml)"
APM_VERSION="$(awk '/^  APM_VERSION:/ {print $2; exit}' Taskfile.yml)"
AGENT_BROWSER_VERSION="$(awk '/^  AGENT_BROWSER_VERSION:/ {print $2; exit}' Taskfile.yml)"

# go-task and agent-browser in ONE npm call: two concurrent `npm i -g` on the
# same prefix can race on its lock, one call cannot, and it is still one
# download wave. Each is skipped when its pinned version is already installed.
install_npm_tools() {
  local pkgs=()
  if [ "$(task --version 2>/dev/null | awk '{print $NF}' | tr -d v)" != "$TASK_VERSION" ]; then
    pkgs+=("@go-task/cli@${TASK_VERSION}")
  fi
  if [ "$(agent-browser --version 2>/dev/null | awk '{print $NF}')" != "$AGENT_BROWSER_VERSION" ]; then
    pkgs+=("agent-browser@${AGENT_BROWSER_VERSION}")
  fi
  if [ "${#pkgs[@]}" -eq 0 ]; then
    log "go-task ${TASK_VERSION} and agent-browser ${AGENT_BROWSER_VERSION} already installed"
    return 0
  fi
  log "npm i -g ${pkgs[*]}"
  npm i -g "${pkgs[@]}" || warn "npm install of ${pkgs[*]} failed"
}

# uv runs the backend and the apm CLI. The image usually has it; when it does
# not, the official installer needs astral.sh, so fall back to pip, which the
# default package-manager allowlist covers. Then warm apm's cache so the hook's
# `uvx` call finds the CLI already downloaded.
install_uv_and_warm_apm() {
  if ! command -v uv >/dev/null 2>&1; then
    log "uv missing; installing"
    if ! { curl -LsSf https://astral.sh/uv/install.sh | sh; }; then
      pip install uv || warn "uv install failed"
    fi
    export PATH="$HOME/.local/bin:$PATH"
  fi
  log "warming apm-cli ${APM_VERSION}"
  uvx --from "apm-cli==${APM_VERSION}" apm --version || warn "apm warmup failed"
}

install_npm_tools &
install_uv_and_warm_apm &
wait

# gh is only checked: --attach needs 2.99 or newer (docs/ux/visual-screenshots.md).
log "gh: $(gh --version 2>/dev/null | head -1 || echo missing)"
log "task: $(task --version 2>/dev/null || echo missing)"
log "agent-browser: $(agent-browser --version 2>/dev/null || echo missing)"

if [ "$WITH_SKILLS" = true ]; then
  log "agent skills (apm install --frozen)"
  uvx --from "apm-cli==${APM_VERSION}" apm install --frozen || warn "apm install failed"
fi

log "done"
exit 0
