#!/bin/bash
#
# Everything `task setup` does, for a session that has no `task`.
#
# WHY THIS EXISTS. A Claude Code on the web container arrives with the repo
# cloned and nothing installed, and go-task is not on its PATH — nothing in this
# repo installs it. So an agent that means to follow CONTRIBUTING.md runs the
# underlying commands by hand, gets the two toolchains it happens to need, and
# works a whole session without the rest. The half that goes missing silently is
# `agents:setup`: `.claude/skills/` stays empty, so the pinned skills never load
# and the agent works without them. That is not a thing to remember. It is a
# thing to make impossible, which is what a SessionStart hook is for.
#
# Mirrors `Taskfile.yml`'s `setup` target step for step, deliberately: when that
# target changes this file has to change with it, and a reader comparing the two
# should see the same list in the same order.
#
# IDEMPOTENT and cheap on a warm container: each dependency step records a hash
# of its lockfile and skips itself when the hash and its output are unchanged,
# so a `resume` start costs seconds rather than minutes.
#
# SPLIT OF LABOUR with scripts/cloud-setup.sh. The environment's Setup script
# installs the slow, global, lockfile-free tools once and is snapshotted. Cloud
# snapshots do not notice lockfile changes, so everything that follows a
# lockfile stays here, in the hook. See docs/contributing/agent-skills.md,
# "Cloud sessions: what is installed and how".
set -euo pipefail

# Local runs already have whatever the developer set up, and this would fight
# their tooling. The web container is the one that starts from nothing.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# Pinned in one place, as the Taskfile does it: `uvx` runs the CLI without a
# global install, so the version is this line rather than whatever is on PATH.
APM_VERSION="$(awk '/^  APM_VERSION:/ {print $2; exit}' Taskfile.yml)"
AGENT_BROWSER_VERSION="$(awk '/^  AGENT_BROWSER_VERSION:/ {print $2; exit}' Taskfile.yml)"

step() { echo "[session-start] $*"; }

# Lockfile stamps: a step is skipped when the hash of its inputs matches the one
# recorded after its last success AND its output still exists (a container that
# lost node_modules must reinstall whatever the stamp says). Stored outside the
# checkout so nothing needs a .gitignore line.
STAMPS="${XDG_CACHE_HOME:-$HOME/.cache}/session-start-stamps"
mkdir -p "$STAMPS"
hash_of() { cat "$@" | sha256sum | cut -d' ' -f1; }
# stale NAME HASH OUTPUT: true when the step has to run.
stale() { [ ! -e "$3" ] || [ "$(cat "$STAMPS/$1" 2>/dev/null || true)" != "$2" ]; }
mark() { printf '%s\n' "$2" > "$STAMPS/$1"; }

# Copy, never hardlink, on every path: nltk pathsec refuses hard-linked corpora
# (`st_nlink=2`), and the Taskfile and Dockerfile do the same.
export UV_LINK_MODE=copy

# go-task, pinned where CI pins it (.github/actions/setup-task). Nothing in a
# fresh container installs it, and every doc names the `task` commands. Not
# fatal: the installers below do not need it, so a failed npm install must not
# stop them.
TASK_VERSION="$(awk -F'"' '/default:/ {print $2; exit}' .github/actions/setup-task/action.yml)"
if ! command -v task >/dev/null 2>&1; then
  step "go-task ${TASK_VERSION} (npm, as CI installs it)"
  npm i -g "@go-task/cli@${TASK_VERSION}" || step "go-task install failed; \`task\` is unavailable this session"
fi

# Never fails the session for an optional tool: a broken registry or a blocked
# host must not stop the required toolchains below.
install_agent_browser() {
  local have
  have="$(agent-browser --version 2>/dev/null | awk '{print $NF}' || true)"
  if [ "$have" = "$AGENT_BROWSER_VERSION" ]; then
    return 0
  fi
  step "agent-browser ${AGENT_BROWSER_VERSION} (npm; was ${have:-absent})"
  npm i -g "agent-browser@${AGENT_BROWSER_VERSION}" ||
    step "WARNING: agent-browser install failed; screenshots are unavailable this session"
}
install_agent_browser || true

# `agent-browser install` downloads Chrome for Testing, and that host is blocked
# by the cloud network policy ("Failed to fetch version info ... tunnel error").
# The image ships Playwright's Chromium, so point agent-browser at it for every
# Bash call of the session. Left alone when the person already configured a
# Chrome of their own.
if [ -z "${AGENT_BROWSER_EXECUTABLE_PATH:-}" ] && [ -z "${AGENT_BROWSER_PROVIDER:-}" ]; then
  PW_CHROME=""
  for candidate in /opt/pw-browsers/chromium /opt/pw-browsers/chromium-*/chrome-linux*/chrome; do
    if [ -x "$candidate" ]; then
      PW_CHROME="$candidate"
      break
    fi
  done
  if [ -n "$PW_CHROME" ]; then
    export AGENT_BROWSER_EXECUTABLE_PATH="$PW_CHROME"
    # CLAUDE_ENV_FILE is the SessionStart mechanism for persisting env vars into
    # the session's later Bash calls. Without it, say what to export by hand.
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
      printf 'export AGENT_BROWSER_EXECUTABLE_PATH=%q\n' "$PW_CHROME" >> "$CLAUDE_ENV_FILE"
    else
      step "CLAUDE_ENV_FILE is unset; run: export AGENT_BROWSER_EXECUTABLE_PATH=${PW_CHROME}"
    fi
  fi
fi

step "backend venv (uv sync --group dev)"
# `uv venv` refuses an existing directory, and a resumed container has one: under
# `set -e` that aborted the whole hook before any later step ran. Create it only
# when it is missing; `uv sync` below would create it anyway.
H="$(hash_of uv.lock pyproject.toml)"
if stale venv "$H" .venv/bin/python; then
  if [ ! -x .venv/bin/python ]; then
    uv venv .venv
  fi
  # pyproject's `requires-python` starts at 3.14.1, so a venv on a 3.14 release
  # candidate is rebuilt on a final 3.14 here, or the sync fails saying why.
  uv sync --group dev
  mark venv "$H"
fi

# Bun, pinned where CI pins it (.github/actions/setup-bun). The container's own
# Bun is whatever its image shipped, and `bun check` (`task workspace:types`) reports
# what the pinned version reports, so a different one is a different gate.
BUN_VERSION="$(awk -F'"' '/default:/ {print $2; exit}' .github/actions/setup-bun/action.yml)"
if [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  step "bun ${BUN_VERSION} (npm, as CI installs it)"
  npm i -g "bun@${BUN_VERSION}" || step "bun ${BUN_VERSION} install failed; using $(bun --version 2>/dev/null || echo none)"
fi

# bun_install NAME DIR: `bun install --frozen-lockfile` in DIR unless its
# lockfile is unchanged and node_modules is still there.
bun_install() {
  local H
  H="$(hash_of "$2/bun.lock" "$2/package.json")"
  if stale "$1" "$H" "$2/node_modules"; then
    step "$1 dependencies (bun)"
    bun install --frozen-lockfile --cwd "$2"
    mark "$1" "$H"
  fi
}

# Bun is the toolchain, never the runtime (ADR-0103) — see `workspace:install`.
# Do not add `--bun`.
bun_install ui apps/workspace
bun_install site apps/site

# Two Node programs, each with its own lockfile. Installing only the policy pack
# leaves `task verify` failing at `infra:types`.
# The same two lines as `task infra:install`, spelled out because `task` itself
# may have failed to install above.
bun_install pulumi deploy/pulumi
bun_install pulumi-policy deploy/pulumi/policy

# The step whose absence is invisible. `--frozen` refuses to install when the
# lockfile is out of sync, which is what makes this reproducible. The stamp
# covers the manifest, the lockfile, the CLI pin and our own skills/, which apm
# copies into .claude/skills.
# shellcheck disable=SC2046  # file names under skills/ have no spaces
H="$(hash_of apm.yml apm.lock.yaml $(find skills -type f | sort))-${APM_VERSION}"
if stale apm "$H" .claude/skills; then
  step "agent skills (apm install --frozen)"
  uvx --from "apm-cli==${APM_VERSION}" apm install --frozen
  mark apm "$H"
fi
step "agent skills present: $(find .claude/skills -mindepth 1 -maxdepth 1 | wc -l)"

# pytest puts this checkout's `src/` first itself (pyproject `pythonpath`), so
# a bare pytest tests this tree. The export still covers everything else that
# imports `agent` by name: `nat run`, ad-hoc scripts and the census.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PYTHONPATH="packages/agent/src"' >> "$CLAUDE_ENV_FILE"
fi

# The agent reads OPENROUTER_API_KEY, and this environment is configured with
# OPENROUTER_KEY. census and the answer suite accept either, but a bare `nat run`
# reads only the first, so alias it for the session. `%q` shell-quotes the value,
# which is written to the env file and never printed.
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -z "${OPENROUTER_API_KEY:-}" ] && [ -n "${OPENROUTER_KEY:-}" ]; then
  printf 'export OPENROUTER_API_KEY=%q\n' "$OPENROUTER_KEY" >> "$CLAUDE_ENV_FILE"
fi

step "done"
