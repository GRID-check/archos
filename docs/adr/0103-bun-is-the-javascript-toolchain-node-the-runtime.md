---
status: proposed
date: 2026-10-13
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Bun is the JavaScript toolchain, Node the runtime

## Context and Problem Statement

Bun came into `frontends/ui` as the installer, and the only written rule about
it was a prohibition: never `--bun`, because Turbopack spawns a real `node` for
its PostCSS step and `NODE_OPTIONS=--bun` kills it (`docs/contributing/gotchas.md`).
Everything else Bun can do was neither adopted nor rejected, and what was in
place had drifted:

- Three Bun versions were in use: 1.3.11 in CI (`setup-bun`) and both UI images,
  1.4.2 in cloud sessions, under a Dockerfile comment asking for lockstep.
- "Installer and script runner" was half true. The scripts it ran handed off at
  once to `node`, `tsx` or `npm run`; `frontends/web`, `deploy/pulumi` and
  `packages/ifc-spatial` installed with npm.
- `tsc` 6 was the UI's slowest gate. Measured on 4 cores, 3,194 files: 113 s and
  3.6 GB with no `.tsbuildinfo` (CI's case), 14.5 s with one. `next build` spent
  70 s of its 165 s in the same checker.

Bun 1.4.3 (2026-10-10) ships `bun check`, a type checker that reports what
TypeScript 7's `tsc` reports. On the same tree it took 6 s and 0.8 GB, and its
one error matched `tsc` 7.0.2's exactly. The question is which of Bun's roles
this repo takes, and where the line sits.

## Decision Drivers

* A gate is only a gate if CI, images and every workstation run the same one.
* The chat socket runs through `server.js` (`http-proxy`, spliced sockets, raw
  frame inspection for rate limits): the runtime under it is the riskiest thing
  to change and the one with the least to gain.
* Buy, don't build: a capability the toolchain already has is not a dependency
  to add (`tsx`) or a module to maintain.

## Considered Options

* Do nothing: Bun installs the UI, `tsc` 6 checks it.
* Bun as the whole JavaScript toolchain (install, scripts, bundling the deploy
  scripts, type checking) on one pinned version; Node stays the runtime.
* The toolchain, and `bun test` in place of vitest.
* The toolchain, and Bun as the production runtime for `server.js` and Next.

## Decision Outcome

Chosen option: "Bun as the whole JavaScript toolchain, Node the runtime",
because it takes the measured win (the type check, one version, one tool) and
leaves alone the two parts where Bun has no measured advantage and a large
compatibility surface.

In this change:

- `.github/actions/setup-bun` pins Bun once (1.4.3). The session hook installs
  that version, and both UI images copy it.
- `task fe:types` is `bun check`, so the UI type checks with TypeScript 7.
  `typescript` is 7.0.2; `next build` runs it too (its type step fell from 70 s
  to 21.6 s, the build from 165 s to 97 s).
- TypeScript 7.0 ships no compiler API. The five structural specs that parse
  source import `typescript-api`, TypeScript 6.0.3 under an npm alias.
- `tsx` is gone: Bun runs the TypeScript scripts directly. The deploy-time
  scripts were already bundled with `bun build` and stay that way, because the
  runtime image carries neither.

The other JavaScript projects (`frontends/web`, `deploy/pulumi`,
`packages/ifc-spatial`) move their installs to Bun in their own change; this
record covers them.

### Consequences

* Good, because the UI's type check drops from 113 s to about 6 s in CI's
  no-cache case, the pre-commit hook with it, and the image build loses 48 s.
* Good, because TypeScript 7 found a real bug on its first run:
  `dev/budget-usage` declared a local `window`, so its fetch shim patched a
  helper function and never the browser's `fetch`. TypeScript 6 accepted it as
  an expando property.
* Good, because one pinned Bun means the type checker CI runs is the one every
  session and image runs, and a test fails when they part.
* Bad, because editors must run TypeScript 7's language server (the
  `TypeScriptTeam.native-preview` VS Code extension). The `typescript` package
  at 7.x has no `tsserver`, and an editor left on 6 disagrees with the gate.
* Bad, because the compiler-API specs pin a second TypeScript until 7.1 ships
  its API, and nothing yet says when that is.
* Bad, because the Bun version is now the type checker's version: a Bun bump is
  a TypeScript bump and must be read as one.
* Neutral, because `incremental` and the Next `plugins` entry in
  `tsconfig.json` are ignored by `bun check`. `tsc` ignored the plugin too.

### Confirmation

* `tests/test_bun_version_pin.py`: every Dockerfile copying `oven/bun` names
  `setup-bun`'s version, and the session hook reads that version rather than
  naming one.
* `task fe:types` is `bun check` and is a required CI step (Frontend job).
* The rest of the line (no `--bun`, no Bun runtime image) is enforced by review
  only, as before; the Dockerfile and `setup-bun` comments say why at the place
  someone would change it.

## Pros and Cons of the Options

### The toolchain, and `bun test` in place of vitest

* Good, because Bun's runner starts faster.
* Bad, because the suite is 1,126 spec files; 583 use `vi.mock`, 125
  `importActual`/`importOriginal`, 530 set an environment per file on
  happy-dom, and coverage is sharded four ways and merged. Bun's module mocks
  are not hoisted like vitest's. It is a rewrite of every spec for no product
  gain.

### The toolchain, and Bun as the production runtime

Measured 2026-10-13: the same production build served by `node server.js` and
`bun server.js` (Bun 1.4.3), against a throwaway Postgres with all migrations
and a WebSocket echo backend.

* Good, because it works: pages render, `/api/healthz` answers, the frame
  limiter closes the same 10 sockets under both, and 200 concurrent chat
  sockets proxy with no failures.
* Good, because it boots 0.5–0.9 s sooner, which a 60 s start period that runs
  migrations first does not notice.
* Bad, because throughput is the same (789–887 ms against 918–1022 ms for
  200 × 20 frames) and resident memory is about 15% higher (≈320 MB against
  ≈280 MB). The proxy waits on the Python agent, not on JavaScript.
* Bad, because the chat path would run on Bun's `node:http` and `net`
  reimplementations, and OpenTelemetry, `postgres`, `ioredis` and
  `drizzle-kit migrate` on its Node compatibility. The smoke test never reached
  the database driver (the routes refused an anonymous caller first).
* Bad, because `bun --bun next build` has open crash reports in exactly the
  "Collecting page data" phase, and Turbopack is Rust: the JavaScript runtime
  barely moves build time.

## More Information

Revisit the runtime when there is a reason Node cannot meet: a measured
latency or memory problem in `server.js`, or a fix the chat path needs that
only Bun has. Revisit the second TypeScript when TypeScript 7.1 ships its API;
the five specs then import `typescript` again and the alias goes.

`ts6to7` (a community codemod) rewrites the tsconfig options TypeScript 7
removed. None of them occur in `frontends/ui`, so it had nothing to do here; it
is the place to start for `deploy/pulumi` and `packages/ifc-spatial`, which
stay on TypeScript 5 for now.
