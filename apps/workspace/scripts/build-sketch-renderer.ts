/**
 * Bundle the sketch renderer's worker (`bff/diagrams/sketch-render-worker.ts`)
 * into one Node module, `dist-sketch-render/sketch-render-worker.mjs` (ADR-0149).
 *
 *   bun scripts/build-sketch-renderer.ts [--outdir <dir>]
 *
 * Everything is inlined: Excalidraw, happy-dom (a devDependency, so it is not
 * in the production `node_modules`) and fontkit. Plain Node cannot import
 * `@excalidraw/excalidraw` itself: its ESM build names `roughjs/bin/rough`
 * without an extension, which only a bundler resolves. Its stylesheet imports
 * become empty modules; the export draws no CSS. Beside it goes
 * `font-coverage.json`, which characters each staged font file has
 * (`bff/diagrams/sketch-font-faces.ts`), so it runs after
 * `copy-excalidraw-assets.mjs`.
 *
 * Run by `bun run build` and `bun run dev:next`; the Docker build runs the
 * former, and the runner copies the output. Not committed (`.gitignore`).
 * The client bundle is untouched: Next never sees this file, only the path
 * `sketch-renderer.ts` starts a worker from. `sketch-renderer.spec.ts` builds
 * it into a temporary directory and renders through it.
 */

import { statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fontCoverage } from '../bff/diagrams/sketch-font-faces'
import { FONT_COVERAGE_FILE } from '../bff/diagrams/sketch-render-types'

/** The slice of Bun's API this script uses; `@types/bun` is not installed (Bun is the toolchain here, ADR-0103). */
interface BunPluginBuilder {
  onResolve(options: { filter: RegExp }, resolve: (args: { path: string }) => { path: string; namespace?: string }): void
  onLoad(options: { filter: RegExp; namespace?: string }, load: () => { contents: string; loader: 'js' }): void
}
declare const Bun: {
  build(options: Record<string, unknown>): Promise<{ success: boolean; logs: readonly unknown[]; outputs: readonly { path: string }[] }>
}

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = path.join(UI_ROOT, 'bff/diagrams/sketch-render-worker.ts')
export const SKETCH_RENDER_BUNDLE = 'sketch-render-worker.mjs'

const noStylesheets = {
  name: 'no-stylesheets',
  setup(build: BunPluginBuilder) {
    build.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'no-css' }))
    build.onLoad({ filter: /.*/, namespace: 'no-css' }, () => ({ contents: 'export default {}', loader: 'js' }))
  },
}

export async function buildSketchRenderer(outdir: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: 'node',
    format: 'esm',
    outdir,
    naming: SKETCH_RENDER_BUNDLE,
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    plugins: [noStylesheets],
    throw: false,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('the sketch renderer did not build')
  }
  // Which font file has which characters, so the worker decodes a file only when a label needs it.
  const fonts = path.join(UI_ROOT, 'public', 'excalidraw', 'fonts')
  writeFileSync(path.join(outdir, FONT_COVERAGE_FILE), JSON.stringify(fontCoverage(fonts)))
  return result.outputs[0].path
}

if (import.meta.main) {
  const flag = process.argv.indexOf('--outdir')
  const outdir = path.resolve(flag > 0 ? process.argv[flag + 1] : path.join(UI_ROOT, 'dist-sketch-render'))
  const file = await buildSketchRenderer(outdir)
  console.log(`[sketch-renderer] wrote ${path.relative(process.cwd(), file)} (${(statSync(file).size / 1e6).toFixed(1)} MB)`)
}
