// @disk-inputs: ../../.github/actions/build-image/action.yml, deploy/Dockerfile
/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import config, { posthogSourcemapConfig } from '../next.config.ts'

/**
 * Source maps for PostHog error tracking: `@posthog/nextjs-config` does the
 * injecting, uploading and deleting inside `next build`. What is ours, and held
 * in place here:
 *  - nothing configured, nothing changes: a fork, a pull request, a local
 *    build and the running server get the config exactly as written;
 *  - configured, the release is `grid-ui` at the commit being built, so an
 *    error's release is the `GIT_SHA` the running container reports;
 *  - the key comes from a BuildKit secret, exported only inside the RUN that
 *    builds, and never reaches a build argument;
 *  - no `.map` survives in the served trees, because Next serves `.next/static`
 *    to anyone and a map carries the original source.
 */

const UI_ROOT = path.resolve(import.meta.dirname, '..')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const configured = {
  POSTHOG_CLI_API_KEY: 'phx_secret',
  POSTHOG_PROJECT_ID: '269895',
  GIT_SHA: SHA,
}

describe('posthogSourcemapConfig', () => {
  it.each([
    ['nothing', {}],
    ['only the project id', { POSTHOG_PROJECT_ID: '269895', GIT_SHA: SHA }],
    ['only the key', { POSTHOG_CLI_API_KEY: 'phx_secret', GIT_SHA: SHA }],
  ])('is off with %s', (_what, env) => {
    expect(posthogSourcemapConfig(env)).toBeNull()
  })

  it('uploads for the commit being built, as release grid-ui, and deletes the maps', () => {
    expect(posthogSourcemapConfig(configured)).toEqual({
      personalApiKey: 'phx_secret',
      projectId: '269895',
      host: 'https://eu.posthog.com',
      sourcemaps: {
        enabled: true,
        releaseName: 'grid-ui',
        releaseVersion: SHA,
        releaseMode: 'symbol-set',
        deleteAfterUpload: true,
      },
    })
  })

  it('honours a host override', () => {
    expect(
      posthogSourcemapConfig({ ...configured, POSTHOG_CLI_HOST: 'https://posthog.example.test' })
        ?.host
    ).toBe('https://posthog.example.test')
  })

  it('refuses to upload without the commit, because a release needs one', () => {
    expect(() => posthogSourcemapConfig({ ...configured, GIT_SHA: ' ' })).toThrow(
      /GIT_SHA/
    )
  })
})

describe('the config Next loads', () => {
  const load = () => config('phase-production-build', { defaultConfig: {} })

  it('is the config as written, with no map flags, when nothing is configured', async () => {
    const loaded = await load()
    expect(loaded.productionBrowserSourceMaps).toBeUndefined()
    expect(loaded.experimental?.serverSourceMaps).toBeUndefined()
    expect(loaded.compiler).toBeUndefined()
  })

  it('is wrapped by withPostHogConfig, with browser and server maps on, when configured', async () => {
    const saved = { ...process.env }
    Object.assign(process.env, configured)
    try {
      const loaded = await load()
      expect(loaded.productionBrowserSourceMaps).toBe(true)
      expect(loaded.experimental?.serverSourceMaps).toBe(true)
      expect(typeof loaded.compiler?.runAfterProductionCompile).toBe('function')
      expect(loaded.skipTrailingSlashRedirect).toBe(true)
    } finally {
      for (const key of Object.keys(configured)) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  })
})

describe('the image build wiring', () => {
  const dockerfile = readFileSync(path.join(UI_ROOT, 'deploy', 'Dockerfile'), 'utf8')
  const action = readFileSync(
    path.join(UI_ROOT, '..', '..', '.github', 'actions', 'build-image', 'action.yml'),
    'utf8'
  )
  const builder = dockerfile.slice(
    dockerfile.indexOf('FROM base AS builder'),
    dockerfile.indexOf('FROM base AS runner')
  )
  const buildRun = builder.slice(builder.lastIndexOf('RUN', builder.indexOf('bun run build')))
  const buildStep = buildRun.slice(0, buildRun.indexOf('\n\n'))

  it('mounts the key as a BuildKit secret and exports it only in the RUN that builds', () => {
    const mounts =
      dockerfile.match(/--mount=type=secret,id=posthog_cli_api_key,required=false/g) ?? []
    expect(mounts).toHaveLength(1)
    expect(buildStep).toContain('--mount=type=secret,id=posthog_cli_api_key')
    expect(buildStep).toContain('export POSTHOG_CLI_API_KEY')
  })

  it('never takes the key as a build argument', () => {
    expect(dockerfile).not.toMatch(/^\s*(ARG|ENV)\s+\w*(API_KEY|KEY)\b/m)
    expect(action).not.toMatch(/POSTHOG_API_KEY=|POSTHOG_CLI_API_KEY=/)
  })

  it('declares the release version and the project id before the build reads them', () => {
    const build = builder.indexOf('bun run build')
    expect(builder.indexOf('ARG GIT_SHA=""')).toBeLessThan(build)
    expect(builder.indexOf('ARG POSTHOG_PROJECT_ID=""')).toBeLessThan(build)
  })

  it('deletes the CLI binary it fetched, which the production install would not prune', () => {
    expect(buildStep).toContain('rm -rf node_modules/@posthog/cli/node_modules/.bin_real')
  })

  it('deletes every map left in the served trees and fails if one survives, in the same RUN', () => {
    expect(buildStep).toContain("find .next/static .next/server -name '*.map' -type f -delete")
    expect(buildStep).toMatch(
      /if find \.next\/static \.next\/server -name '\*\.map' \| grep -q \.; then .*exit 1/
    )
    expect(buildStep).toMatch(/grep -rlq 'chunkId=' .*exit 1/s)
  })

  it('passes the key as a secret from the build-image action, for the frontend image only', () => {
    expect(action).toMatch(
      /secrets: \$\{\{ inputs\.name == 'frontend' && inputs\.posthog-api-key != ''/
    )
  })
})
