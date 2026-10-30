# Agent skills

`skills/` is the single source. Everything else is generated.

Every skill this repo authors lives in [`../../skills/`](../../skills/), listed
in [`../../apm.yml`](../../apm.yml) as a local path beside the pinned
third-party ones. apm publishes the whole set into each harness directory named
in that manifest's `targets`, so `.claude/` and `.agents/` are **generated and
gitignored** and nothing in them is source.

```bash
task agents:setup   # publish every skill in apm.yml to every target
task agents:audit   # THE GATE: fails when apm.lock.yaml is stale against skills/
task agents:update  # refresh the third-party pins, then review the diff
```

**Edit a skill, commit `apm.lock.yaml` with it.** The lockfile records a hash of
every deployed file, so an edit under `skills/` invalidates it — and because the
deployment is gitignored, nothing in your diff says so. `task agents:audit` is
what catches that, and `task lint:repo` and CI's Repo checks job both run it. It
re-deploys from `skills/` and fails if the lockfile changed, leaving the correct
file on disk for you to commit. (Its own `apm audit` exits 0 on drift, which is
why the task is a wrapper and not a one-liner; the lockfile went stale against
seven files before this gate existed.)

Adding a harness is one line in `targets`. Adding a skill is a directory in
`skills/` and one line in `dependencies.apm`. There is no copy step to keep in
sync, which is the point: an earlier version of this had a script symlinking
one directory into another, and before that, ten committed files that *looked*
like symlinks and were plain text containing a path (git mode `100644`, not
`120000`). None of them resolved, so none of those skills had ever loaded for
anyone. Publishing from one source removes the category.

How to add one: [`../../skills/README.md`](../../skills/README.md).

## Skill or document

A skill of our own exists only for a procedure that is agent-specific: one only
an agent carries out, that depends on the agent's tools or harness, or whose
value is being triggered by its description at the right moment. Everything a
contributor needs as much as an agent is documentation, and the `AGENTS.md` of
the area points at it at the moment an agent needs it. A skill that only points
at documents is a pointer, and a pointer is one line in an `AGENTS.md`.

This applies to the skills we write. The pinned third-party skills below are
dependencies and are chosen on their own merits.

The October 2026 audit applied the rule to the ten skills `skills/` held then.
Seven came from the upstream NVIDIA AI-Q blueprint and still described it in
places: DCO sign-off, copy-pr-bot, a Sphinx docs tree, Helm charts. That content
was deleted rather than moved.

| Skill | Decision | Why | Now |
|---|---|---|---|
| `aiq-research` | deleted | Agent-specific, but an upstream NVIDIA catalog skill for driving a blueprint backend, with a signature that no longer matched its files. Its backend launcher `scripts/start_as_skill.sh` went with it | |
| `aiq-definition-of-done` | moved | The bar for "done" binds people and agents alike | [definition-of-done.md](definition-of-done.md), with a row in `AGENTS.md` |
| `aiq-prepare-pr` | moved | Opening a pull request is contributor knowledge | [`CONTRIBUTING.md`](../../CONTRIBUTING.md#opening-a-pull-request) |
| `aiq-release-qa` | deleted | What to run per surface was already [testing-and-verification.md](testing-and-verification.md) and the definition of done; the rest was stale | |
| `aiq-maintain-ci` | moved | CI maintenance is contributor knowledge, and [ci.md](ci.md) already held most of it | [ci.md, "Changing CI"](ci.md#changing-ci) |
| `aiq-add-tool`, `aiq-add-data-source` | merged and moved | One procedure, needed by anyone extending the agent | [adding-a-tool.md](../architecture/adding-a-tool.md) |
| `aiq-customize-prompts-models` | moved | Prompt and model configuration is architecture knowledge | [llm-providers.md](../architecture/llm-providers.md#which-model-each-role-uses) and the prompt section of [backend-deep-dive.md](../architecture/backend-deep-dive.md#prompts-three-layers-and-where-each-is-authored) |
| `aiq-piloti-riso` | moved | A designer making a print needs the series rules as much as an agent does | [`packages/brand/art/riso/README.md`](../../packages/brand/art/riso/README.md#making-a-print) |
| `aiq-deploy` | deleted | A deployment runbook, and the upstream blueprint's: it cloned NVIDIA's repository and deployed with Helm | [`docs/deployment/`](../deployment/), [`scripts/README.md`](../../scripts/README.md) |

## Installed

Third-party skills sit in the same manifest, pinned to a commit and locked in
`apm.lock.yaml`, fetched by [apm](https://github.com/microsoft/apm).

| Skill | Fires | Why |
|---|---|---|
| `unslop` | automatically, on any writing | This repo carries a lot of prose |
| `writing-for-agents` | automatically, when you touch a skill, `AGENTS.md` or `CLAUDE.md` | The rules `AGENTS.md` is now written to |
| `typescript-best-practices` | automatically, on any `.ts`/`.tsx` | `apps/workspace` is most of the surface area |
| `how` | automatically, on "how does X work" and placement questions | Four layers can own a feature here, so "which layer" recurs |
| `why` | automatically, on "why does X work this way", rationale, postmortems | The question `docs/adr/` exists to answer. `how` reads the code, `why` reconstructs the forces from history, issues and docs |
| `technical-writing` | by name | Human-facing prose: docs, RFCs, PR bodies. `writing-for-agents` covers what an agent consumes |
| `interrogate` | by name | Adversarial multi-model review of a diff |
| `blast-radius` | by name | Changes whose danger sits outside the diff |
| `principle-model-the-domain` | by name | Encode the domain in a structure instead of scattered conditionals |
| `improve-codebase-architecture` | by name | Scans for shallow modules, reports candidates, then walks the chosen one. Reads `docs/adr/` so it does not re-propose decisions we already recorded |
| `codebase-design` | by name, and by the skill above | The architecture vocabulary the report is written in |
| `grilling` | by name, and by the skill above | The decision loop once a candidate is picked |
| `domain-modeling` | by name, and by the skill above | Keeps a `CONTEXT.md` glossary current as terms sharpen |
| `emil-design-eng` | automatically, on UI polish and motion work | The bar for interface craft: easing, duration, origin, press feedback, the invisible details |
| `animate` | automatically, when building a new animation | Walks the decisions in order: should it animate, purpose, curve, duration, interruption, exit |
| `improve-animations` | automatically, on "audit the motion" or "make this feel better" | Read-only audit that writes self-contained plans for a cheaper executor |
| `find-animation-opportunities` | automatically, on "what could animate here" | Proposes motion with exact values, and says what must not animate |
| `animation-performance` | automatically, on jank and dropped frames | The composite-only rules, Motion's main-thread shorthands, inherited CSS variable cost |
| `animation-vocabulary` | automatically, on "what is it called when" | Names a motion effect so a prompt or a review can ask for it precisely |
| `apple-design` | automatically, on gestures, springs, sheets, materials, typography | The physical-motion half of the bar; our sheets and spring catalog are its territory |
| `mobile-native` | automatically, on touch and PWA work | Piloti is a mobile-first PWA: tap highlight, `dvh`, input zoom, safe areas |
| `break-ui` | automatically, on "stress-test this component" | Worst-case data: long German compound names, empty lists, huge counts |
| `ask-sonner` | automatically, on toast work | `apps/workspace` uses Sonner (`components/ui/sonner.tsx`) |
| `review-animations` | by name | The strict reviewer for a motion diff; approval is earned |
| `pick-ui-library` | by name | A curated list to check before hand-rolling a general component ("Buy, don't build") |
| `prototype` | by name | Several variants of one piece of UI behind a picker, to choose by feel |

The four from `improve-codebase-architecture` to `domain-modeling` are one capability. `improve-codebase-architecture` calls the
Skill tool for the other three by name, so taking it alone leaves three dead
calls. It also reads and maintains the root [`CONTEXT.md`](../../CONTEXT.md),
the domain glossary; the engineering vocabulary is in
[`docs/glossary.md`](../glossary.md).

Eight are from [pstack](https://github.com/cursor/plugins/tree/main/pstack),
picked out of its 44, and five from
[mattpocock/skills](https://github.com/mattpocock/skills).
Thirteen are from [emilkowalski/skills](https://github.com/emilkowalski/skills),
which is all of it except `animate-expo` and `write-swift`: there is no React
Native or Swift in this repo. Where one of them disagrees with the motion
vocabulary in [`design-language.md`](../design/design-language.md#motion-vocabulary),
the design language wins until it is changed, and changing it is a decision
recorded there, not a drift in one component.
`apm install cursor/plugins/pstack` takes the whole plugin in one dependency if
you want the rest; the cost is context load from the ones that fire on their own.

### Deliberately not taken

pstack ships roughly twenty `principle-*` skills. Most of them restate something
this repo already says in a place that loads earlier and carries our own worked
examples, and a second copy of a rule is sediment rather than reinforcement:

| Skill | Already covered by |
|---|---|
| `principle-encode-lessons-in-structure` | [the correction ratchet](correction-ratchet.md) |
| `principle-fix-root-causes` | "Fix causes, not symptoms", `AGENTS.md` |
| `principle-subtract-before-you-add` | "Question necessity first, then simplify", `AGENTS.md` |
| `principle-never-block-on-the-human` | "Finish the task", `AGENTS.md` |
| `principle-prove-it-works` | [the definition of done](definition-of-done.md) |
| `principle-type-system-discipline` | the `any` ban, [code-conventions.md](code-conventions.md) |
| `principle-guard-the-context-window` | [agent-onboarding-files.md](agent-onboarding-files.md) |

**`no-comments` would actively damage this codebase.** It deletes explanatory
comments on application logic and keeps only constraint comments. The long "why"
headers in `common/source_kinds.py`, `cards/registry.py`, `Taskfile.yml` and
`.gitignore` are the design documents that stayed next to the code, and several
scoped `AGENTS.md` files point readers at them on purpose. Do not add it.

**`create-verification-skill`** generates its harness into `.cursor/skills/`, a
fourth harness path that `apm.yml` does not target, and this repo already proves
behaviour through `task verify` and captures attached to the pull request
(`docs/ux/visual-screenshots.md`).

A skill carrying `disable-model-invocation: true` never triggers by itself. Ask
for it by name. That is deliberate for `interrogate` and `blast-radius`, which
spawn subagents.

## Cloud sessions: what is installed and how

A Claude Code cloud session starts from a container with the repository cloned
and nothing else installed. Two pieces make `agent-browser`, `apm` and the
pinned skills present in every session, with nobody installing anything by hand.

**Paste this one line into claude.ai, environment settings, Setup script:**

```bash
bash archos/scripts/cloud-setup.sh
```

The script starts in the directory above the clone and finds the repository from
its own location. `archos` is the clone's directory name; change it if the
environment clones under another name. For a session that attaches several
repositories, use `bash archos/scripts/cloud-setup.sh --with-skills` (see
"Why two pieces" below).

| Piece | Runs | Does |
|---|---|---|
| [`scripts/cloud-setup.sh`](../../scripts/cloud-setup.sh) | once per environment snapshot, as root, before Claude starts | Installs go-task and `agent-browser` (one `npm i -g`, pinned), installs `uv` if missing, warms the `apm` CLI cache, reports `gh`. Needs no secrets |
| `.claude/hooks/session-start.sh` | every `startup` and `resume` session (matcher `startup\|resume`, timeout 540 s), only when `CLAUDE_CODE_REMOTE=true` | Mirrors `task setup`: venv, the four bun installs, `apm install --frozen` (28 skills into `.claude/skills` and `.agents/skills`), and, if missing, the pinned `agent-browser`. Each step records a hash of its lockfile and skips itself when it and its output are unchanged, so a warm start takes about a second |

The pins live in one place: `APM_VERSION` and `AGENT_BROWSER_VERSION` in
`Taskfile.yml`, the go-task version in `.github/actions/setup-task`. Both
scripts and the Taskfile read them from there.

### Why two pieces

- **Snapshot.** If the Setup script finishes in about five minutes, the disk is
  snapshotted and later sessions skip it. Over that, it runs every session and
  can fail with a generic container error. So it holds only slow, global tools,
  runs independent installs in parallel and sleeps never.
- **Exit codes.** A non-zero exit stops the session from starting. Every step
  of both scripts is therefore non-fatal where the tool is optional, and prints
  a `WARNING` instead.
- **Lockfiles.** The snapshot is rebuilt only when the script or the allowed
  domains change, or after about a week. It never notices a changed `uv.lock`
  or `bun.lock`, so project dependencies belong in the hook, which hashes them.
- **Secrets and bun.** The script runs before the proxy that adds network
  secrets, so it uses none, and bun has known trouble with that proxy, so it
  installs with npm.
- **Several repositories.** A session with more than one repository loads none
  of their `.claude/settings.json`, so the hook never runs there. The
  `--with-skills` flag publishes the apm skills from the setup line itself.
  Dependencies for the other tiers still need `task setup`.

### Chromium for `agent-browser`

`agent-browser install` downloads Chrome for Testing from a host the cloud
network policy blocks. The image ships Playwright's Chromium instead, so the
hook appends `export AGENT_BROWSER_EXECUTABLE_PATH=/opt/pw-browsers/chromium` to
`$CLAUDE_ENV_FILE`, the file Claude Code reads after a SessionStart hook to
persist environment variables into every later Bash call. It does this only when
that path exists and you have configured no Chrome of your own
(`AGENT_BROWSER_EXECUTABLE_PATH` or `AGENT_BROWSER_PROVIDER`). If
`CLAUDE_ENV_FILE` is unset, the hook prints the export line instead. Do not run
`agent-browser install` in a cloud session.

### Verify

```bash
agent-browser --version          # the AGENT_BROWSER_VERSION pin
agent-browser doctor             # or: task agents:browser
ls .claude/skills | wc -l        # 28
```

`task agents:setup` does the same on a developer machine (apm skills, then
`agents:browser`). The hook is silent about a healthy warm start; its
`[session-start]` lines show what it did.

`apm install` reports `1 file(s) contain hidden characters`. It is the vendored
`improve-animations` skill from `emilkowalski/skills` (`--verbose` names it). It
is third-party content under a commit pin, `apm audit` treats it as info, and
`task agents:audit` does not gate on it.

## Two things to know before trusting them

**`interrogate` is weaker here than upstream.** It reads a reviewer list from
`~/.cursor/rules/pstack-models.mdc` and defaults to a cross-vendor panel
(`gpt-5.6-sol-max`, `grok-4.6-fast-xhigh`). Neither exists in this setup, so it
falls back to Claude reviewers. Its adversarial signal comes from model
diversity, so a single-vendor panel is a diminished version of the skill. The
vendored text also says `Task` tool and `subagent_type: generalPurpose`; here
that is the `Agent` tool with `subagent_type: general-purpose`.

**`unslop` rule 13 bans em dashes outright.** Every `AGENTS.md` and `CLAUDE.md`
holds to it. This directory was swept once and drifts back on every merge that
adds a row, because nothing enforces the rule: it lives in this paragraph and in
review, not in a gate. Sweeping a contributor's merged prose to keep the claim
true is not worth the diff either, so treat it as the house style for anything
you write here rather than as a property of the directory. The rest of `docs/`
was never swept at all. Two deliberate exceptions: the `next dev` block at the top of
`apps/workspace/AGENTS.md`, which regenerates itself, and ADR titles quoted in
`docs/adr/README.md`, which have to match the records they point at.

Rule 26 bans some words as metaphors. The house decision for the two this repo
used is in [`naming.md`](naming.md#house-words): keep "ratchet" for a check
whose baseline only falls; say what "substrate" meant instead (the sharing
layer, the shared code).

**apm 0.28 resolves targets inconsistently, and names them inconsistently.**
Autodetection in `install` and in the `audit` replay disagree, which reported
files `install` never wrote as drift, so `apm.yml` pins `targets` rather than
relying on detection. The name for the shared `.agents/skills/` path is
`agent-skills` in a manifest, while the CLI's `--target` help also lists
`agents`, which a manifest rejects.
