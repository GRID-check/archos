/**
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The source-map step of the frontend image build, run as the Dockerfile runs
 * it: `sh deploy/upload-sourcemaps.sh .next`, with a `posthog-cli` stub on PATH.
 *
 * What these cases hold in place:
 *  - nothing configured, nothing uploaded, and the build still passes (a fork, a
 *    pull request and a local `docker build` all take this path);
 *  - the upload names the commit being built as the release, so an error's
 *    release is the `GRID_GIT_SHA` the running container reports;
 *  - the key is read from the secret mount and never reaches an argument list;
 *  - the build fails if a `.map` survives, because Next serves `.next/static`
 *    to anyone and the map carries the original source.
 */

const UI_ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(UI_ROOT, 'deploy', 'upload-sourcemaps.sh')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const ROOT = mkdtempSync(path.join(tmpdir(), 'upload-sourcemaps-'))
const BIN = path.join(ROOT, 'bin')
const KEY_FILE = path.join(ROOT, 'posthog_cli_api_key')
const CALLS = path.join(ROOT, 'cli-calls')

beforeAll(() => {
  mkdirSync(BIN, { recursive: true })
  const cli = path.join(BIN, 'posthog-cli')
  // The real CLI injects `//# chunkId=` into each chunk and, with
  // --delete-after, removes the maps. Both are switched off per case.
  writeFileSync(
    cli,
    [
      '#!/bin/sh',
      `printf '%s|key=%s|project=%s\\n' "$*" "$POSTHOG_CLI_API_KEY" "$POSTHOG_CLI_PROJECT_ID" >> "${CALLS}"`,
      '[ -z "${STUB_FAIL:-}" ] || exit 1',
      'for a in "$@"; do if [ "$prev" = "--directory" ]; then dir="$a"; fi; prev="$a"; done',
      '[ -n "${STUB_NO_INJECT:-}" ] || find "$dir/static" -name "*.js" | while read -r f; do echo "//# chunkId=stub" >> "$f"; done',
      '[ -n "${STUB_KEEP_MAPS:-}" ] || find "$dir" -name "*.map" -delete',
    ].join('\n') + '\n'
  )
  chmodSync(cli, 0o755)
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(CALLS, { force: true })
  rmSync(KEY_FILE, { force: true })
})

/** A `.next` with a browser chunk, a server chunk and a cached copy, each with its map. */
function buildTree() {
  const dir = mkdtempSync(path.join(ROOT, 'next-'))
  const next = path.join(dir, '.next')
  for (const file of ['static/chunks/app.js', 'server/chunks/route.js', 'cache/webpack/copy.js']) {
    const target = path.join(next, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, `console.log(1)\n//# sourceMappingURL=${path.basename(file)}.map\n`)
    writeFileSync(`${target}.map`, '{"version":3,"sources":["a.ts"],"mappings":""}')
  }
  return { dir, next }
}

function run(next, env = {}, { withMaps = true } = {}) {
  if (!withMaps) {
    spawnSync('find', [next, '-name', '*.map', '-delete'])
  }
  const result = spawnSync('sh', [SCRIPT, next], {
    encoding: 'utf8',
    env: {
      PATH: `${BIN}:${process.env.PATH ?? ''}`,
      POSTHOG_API_KEY_FILE: KEY_FILE,
      ...env,
    },
  })
  const calls = existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n') : []
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls }
}

const configured = { POSTHOG_PROJECT_ID: '269895', GRID_GIT_SHA: SHA }

describe('upload-sourcemaps.sh without PostHog configured', () => {
  it('uploads nothing and passes when no map was built', () => {
    const { next } = buildTree()
    const r = run(next, {}, { withMaps: false })
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([])
  })

  it('uploads nothing when the project id is set but the key is not mounted', () => {
    const { next } = buildTree()
    const r = run(next, configured, { withMaps: false })
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([])
  })

  it('uploads nothing when the key is mounted but no project id is given', () => {
    writeFileSync(KEY_FILE, 'phx_secret')
    const { next } = buildTree()
    const r = run(next, { GRID_GIT_SHA: SHA }, { withMaps: false })
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([])
  })

  it('fails the build when a map would be served anyway', () => {
    const { next } = buildTree()
    const r = run(next, {})
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('would ship')
  })
})

describe('upload-sourcemaps.sh with PostHog configured', () => {
  it('injects and uploads for the commit being built, then leaves no map behind', () => {
    writeFileSync(KEY_FILE, 'phx_secret')
    const { next } = buildTree()
    const r = run(next, configured)
    expect(r.status).toBe(0)
    expect(r.calls).toHaveLength(1)
    const [argv] = r.calls[0].split('|')
    expect(argv).toBe(
      `--host https://eu.posthog.com sourcemap process --directory ${next} --exclude ${next}/cache/** ` +
        `--release-name grid-ui --release-version ${SHA} --delete-after`
    )
    expect(r.stdout).toContain(`grid-ui@${SHA}`)
    expect(existsSync(path.join(next, 'static/chunks/app.js.map'))).toBe(false)
    expect(readFileSync(path.join(next, 'static/chunks/app.js'), 'utf8')).toContain('chunkId=')
  })

  it('hands the key to the CLI in its environment, never on the command line', () => {
    writeFileSync(KEY_FILE, 'phx_secret')
    const { next } = buildTree()
    const [argv, ...env] = run(next, configured).calls[0].split('|')
    expect(argv).not.toContain('phx_secret')
    expect(env).toEqual(['key=phx_secret', 'project=269895'])
  })

  it('honours the host and release name overrides', () => {
    writeFileSync(KEY_FILE, 'phx_secret')
    const { next } = buildTree()
    const [argv] = run(next, {
      ...configured,
      POSTHOG_CLI_HOST: 'https://posthog.example.test',
      POSTHOG_RELEASE_NAME: 'grid-ui-staging',
    }).calls[0].split('|')
    expect(argv).toContain('--host https://posthog.example.test')
    expect(argv).toContain('--release-name grid-ui-staging')
  })

  it('refuses to upload without the commit, because a release needs one', () => {
    writeFileSync(KEY_FILE, 'phx_secret')
    const { next } = buildTree()
    const r = run(next, { POSTHOG_PROJECT_ID: '269895' })
    expect(r.status).not.toBe(0)
    expect(r.calls).toEqual([])
  })

  it('fails the build when the upload fails', () => {
    writeFileSync(KEY_FILE, 'phx_secret')
    const { next } = buildTree()
    expect(run(next, { ...configured, STUB_FAIL: '1' }).status).not.toBe(0)
  })

  it('fails the build when the CLI leaves a map in the served tree', () => {
    writeFileSync(KEY_FILE, 'phx_secret')
    const { next } = buildTree()
    const r = run(next, { ...configured, STUB_KEEP_MAPS: '1' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('would ship')
  })

  it('fails the build when no chunk id was injected, since no stack frame could be matched', () => {
    writeFileSync(KEY_FILE, 'phx_secret')
    const { next } = buildTree()
    const r = run(next, { ...configured, STUB_NO_INJECT: '1' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('no chunk id')
  })
})

describe('the image build wiring', () => {
  const dockerfile = readFileSync(path.join(UI_ROOT, 'deploy', 'Dockerfile'), 'utf8')
  const action = readFileSync(
    path.join(UI_ROOT, '..', '..', '.github', 'actions', 'build-image', 'action.yml'),
    'utf8'
  )

  it('mounts the key as a BuildKit secret in both steps that read it', () => {
    const mounts =
      dockerfile.match(/--mount=type=secret,id=posthog_cli_api_key,required=false/g) ?? []
    expect(mounts).toHaveLength(2)
  })

  it('never takes the key as a build argument', () => {
    expect(dockerfile).not.toMatch(/^\s*(ARG|ENV)\s+\w*(API_KEY|KEY)\b/m)
    expect(action).not.toMatch(/POSTHOG_API_KEY=|POSTHOG_CLI_API_KEY=/)
  })

  it('runs the upload after the production install and before the runner stage copies .next', () => {
    const upload = dockerfile.indexOf('sh deploy/upload-sourcemaps.sh .next')
    expect(upload).toBeGreaterThan(dockerfile.indexOf('bun install --frozen-lockfile --production'))
    expect(upload).toBeLessThan(dockerfile.indexOf('FROM base AS runner'))
  })

  it('declares GRID_GIT_SHA only after the build layers, so a new commit keeps them cached', () => {
    const arg = dockerfile.indexOf('ARG GRID_GIT_SHA=""')
    expect(arg).toBeGreaterThan(
      dockerfile.indexOf('RUN bun install --frozen-lockfile --production')
    )
  })

  it('passes the key as a secret from the build-image action, for the frontend image only', () => {
    expect(action).toMatch(
      /secrets: \$\{\{ inputs\.name == 'frontend' && inputs\.posthog-api-key != ''/
    )
  })
})

describe('next.config.ts source map flags', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function configWith(value) {
    vi.resetModules()
    if (value === undefined) vi.stubEnv('GRID_SOURCEMAPS', '')
    else vi.stubEnv('GRID_SOURCEMAPS', value)
    return (await import('../next.config.ts')).default
  }

  it('emits no source map unless the build is going to upload and delete them', async () => {
    const config = await configWith(undefined)
    expect(config.productionBrowserSourceMaps).toBe(false)
    expect(config.experimental.serverSourceMaps).toBe(false)
  })

  it('emits browser and server maps when the Dockerfile asks for them', async () => {
    const config = await configWith('1')
    expect(config.productionBrowserSourceMaps).toBe(true)
    expect(config.experimental.serverSourceMaps).toBe(true)
  })
})
