/**
 * @vitest-environment node
 *
 * The `bff-jobs` slice bundle builds, and PLAIN NODE loads it (ADR-0079,
 * amendment 1). Each assertion is a failure the bundle met on its way here:
 * `server-only` throwing on import, `next/server` without its file name, the
 * AuthKit build importing `next/cache` the same way, a CommonJS package's
 * named export, JSX compiled for development. All of them pass `bun build` and
 * fail only when Node loads the result, so this loads it in a real Node
 * process, never through Vite, which forgives every one of them.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const UI_ROOT = path.resolve(import.meta.dirname, '..')
// Inside the UI's node_modules, so the bundle's package imports resolve as they
// do from `dist-jobs/` in the image.
const CACHE = path.join(UI_ROOT, 'node_modules', '.cache')

/** Imports the bundle and every package it imports only on demand, in Node. */
const PROBE = `
const file = process.argv[1]
const bundle = await import(file)
const source = (await import('node:fs')).readFileSync(file, 'utf8')
const lazy = [...source.matchAll(/(?:import|__require)\\("([^".][^"]*)"\\)/g)].map((m) => m[1])
const failed = []
for (const specifier of new Set(lazy)) {
  try { await import(specifier) } catch (error) { failed.push(specifier + ': ' + error.message.slice(0, 200)) }
}
console.log(JSON.stringify({ exports: Object.keys(bundle).sort(), lazy: [...new Set(lazy)], failed }))
`

describe('the bff-jobs slice bundle', () => {
  let dir
  let file
  let build

  beforeAll(() => {
    mkdirSync(CACHE, { recursive: true })
    dir = mkdtempSync(path.join(CACHE, 'jobs-bundle-spec-'))
    build = spawnSync('bun', ['scripts/build-jobs-bundle.ts', '--outdir', dir], { cwd: UI_ROOT, encoding: 'utf8' })
    file = path.join(dir, 'slice.mjs')
  }, 120_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('builds', () => {
    expect(build.status, build.stderr).toBe(0)
  })

  it('loads in plain Node and exports what the runner calls', () => {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE, file], {
      cwd: UI_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production' },
    })
    expect(probe.status, probe.stderr).toBe(0)
    const result = JSON.parse(probe.stdout.trim().split('\n').at(-1))
    expect(result.exports).toEqual(expect.arrayContaining(['initSliceHost', 'runSlice', 'shutdownSliceHost']))
    // The packages a handler imports only when it runs (an IFC parser, the
    // citation formats) are not exercised by loading the bundle; import them too.
    expect(result.lazy.length).toBeGreaterThan(0)
    expect(result.failed).toEqual([])
  }, 120_000)

  it('is compiled for production', () => {
    const source = readFileSync(file, 'utf8')
    // The production build of `react/jsx-dev-runtime` exports no `jsxDEV`.
    expect(source).not.toContain('react/jsx-dev-runtime')
    // Node's ESM loader needs the file name of a `next/*` entry.
    expect(source.match(/from "next\/[a-z-]+"/g) ?? []).toEqual([])
  })

  it('is built into the image and copied to where the runner imports it from', () => {
    const dockerfile = readFileSync(path.join(UI_ROOT, 'deploy', 'Dockerfile'), 'utf8')

    expect(dockerfile).toMatch(/^RUN bun scripts\/build-jobs-bundle\.ts$/m)
    expect(dockerfile).toMatch(/^COPY --from=builder \S+ \/app\/dist-jobs \.\/dist-jobs$/m)
  })
})
