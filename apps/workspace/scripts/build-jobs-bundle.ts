/**
 * Bundle the `bff-jobs` slice entry (`bff/jobs-queue/slice-entry.ts`) into
 * one ESM file, `dist-jobs/slice.mjs`, that plain Node imports (ADR-0079,
 * amendment 1). `workers/jobs/runner.js` loads it when
 * `BFF_JOBS_MODE=inprocess`, so a job pod runs its slices without booting
 * the Next server.
 *
 *   bun scripts/build-jobs-bundle.ts [--outdir <dir>]
 *
 * Our `src/` is inlined; packages stay imports and resolve from the image's
 * production `node_modules`, as the deploy scripts in `dist-scripts/` do. A
 * package keeps its own files on disk that way (fonts, workers, `#imports`),
 * which inlining it would cut it off from. What plain Node cannot load as Next
 * would, and what this does about it (gotchas.md, "the jobs bundle"):
 *
 * - `server-only` throws on import outside React's server condition; Next
 *   resolves it to an empty module, and so does this.
 * - `next/server` and its siblings have no `exports` map, so Node's ESM loader
 *   needs the file name: `next/server.js`.
 * - `@workos-inc/authkit-nextjs` is ESM that imports `next/cache` the same
 *   extensionless way, from inside `node_modules` where no rewrite reaches, so
 *   it is inlined and its `next/*` imports are rewritten with ours.
 * - `process.env.NODE_ENV` is fixed to production, as `next build` fixes it:
 *   otherwise JSX compiles to `react/jsx-dev-runtime`, whose production build
 *   exports no `jsxDEV`, and every PDF a job renders would throw.
 *
 * A CommonJS package must be imported by its default export (`exceljs`): Node
 * cannot see a CommonJS module's named exports, and the bundle fails to load.
 * `slice-bundle.spec.ts` builds this and imports the result, so each of these
 * fails a test rather than a pod.
 */

import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The slice of Bun's API this script uses; `@types/bun` is not installed (Bun is the toolchain here, ADR-0103). */
interface BunResolveArgs {
  readonly path: string
  readonly resolveDir: string
}
type BunResolved = { path: string; namespace?: string; external?: boolean }
interface BunPluginBuilder {
  onResolve(options: { filter: RegExp }, resolve: (args: BunResolveArgs) => BunResolved): void
  onLoad(options: { filter: RegExp; namespace: string }, load: () => { contents: string; loader: 'js' }): void
}
interface BunPlugin {
  readonly name: string
  setup(build: BunPluginBuilder): void
}
declare const Bun: {
  build(options: Record<string, unknown>): Promise<{ success: boolean; logs: readonly unknown[]; outputs: readonly { path: string }[] }>
  resolveSync(specifier: string, from: string): string
}

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = path.join(UI_ROOT, 'bff/jobs-queue/slice-entry.ts')
/** Packages inlined rather than imported, each for the reason in the header. */
const INLINED_PACKAGES = /^@workos-inc\/authkit-nextjs$/

const nextHostShims: BunPlugin = {
  name: 'next-host-shims',
  setup(build) {
    build.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'empty-module' }))
    build.onLoad({ filter: /.*/, namespace: 'empty-module' }, () => ({ contents: 'export {}', loader: 'js' }))
    build.onResolve({ filter: /^next\/[a-z-]+$/ }, (args) => ({ path: `${args.path}.js`, external: true }))
    build.onResolve({ filter: INLINED_PACKAGES }, (args) => ({ path: Bun.resolveSync(args.path, args.resolveDir) }))
  },
}

async function buildJobsBundle(outdir: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: 'node',
    format: 'esm',
    packages: 'external',
    outdir,
    naming: 'slice.mjs',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [nextHostShims],
    throw: false,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('the jobs bundle did not build')
  }
  return result.outputs[0].path
}

const flag = process.argv.indexOf('--outdir')
const outdir = path.resolve(flag > 0 ? process.argv[flag + 1] : path.join(UI_ROOT, 'dist-jobs'))
const file = await buildJobsBundle(outdir)
console.log(`[jobs-bundle] wrote ${path.relative(process.cwd(), file)} (${(statSync(file).size / 1e6).toFixed(1)} MB)`)
