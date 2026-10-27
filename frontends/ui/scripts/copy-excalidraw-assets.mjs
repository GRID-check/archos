#!/usr/bin/env node
/**
 * Stage Excalidraw's fonts into `public/excalidraw/fonts/`.
 *
 * The sketch editor (`features/diagrams/sketch/sketch-canvas.tsx`) sets
 * `window.EXCALIDRAW_ASSET_PATH = '/excalidraw/'`. Without that, and without
 * these files behind it, Excalidraw 0.18 fetches every font from
 * `https://esm.sh/@excalidraw/excalidraw@<version>/dist/prod/`, its
 * `ASSETS_FALLBACK_URL`: a public CDN learning which office opened a sketch,
 * and a dependency on a third party being up.
 *
 * All of them, Xiaolai's 13 MB of CJK subsets included. A font missing here
 * does not fail quietly; Excalidraw retries it from the CDN. Each subset is
 * fetched only when a glyph in its unicode range is drawn, so the size is disk
 * in the image, not bytes a reader downloads.
 *
 * Same lifecycle as `copy-pdfjs-assets.mjs`: run on `postinstall`, `dev` and
 * `build` (the Docker build installs with `--ignore-scripts`), output
 * gitignored.
 */

import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const UI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(UI_ROOT, 'public', 'excalidraw')

const require = createRequire(import.meta.url)
// The package's `exports` map hides `package.json`, so resolve the entry
// (`dist/prod/index.js`) and climb two levels to the package root.
const packageRoot = join(dirname(require.resolve('@excalidraw/excalidraw')), '..', '..')
const FONTS = join(packageRoot, 'dist', 'prod', 'fonts')

async function main() {
  try {
    await stat(FONTS)
  } catch {
    throw new Error(`@excalidraw/excalidraw has no fonts at ${FONTS}`)
  }
  // A stale copy after a version bump would serve fonts whose hashed names the
  // new bundle no longer asks for, and every miss goes to the CDN.
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })
  await cp(FONTS, join(OUT_DIR, 'fonts'), { recursive: true })
  const { version } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  process.stdout.write(`✔ Excalidraw ${version} fonts staged in public/excalidraw\n`)
}

main().catch((error) => {
  process.stderr.write(`✖ failed to stage Excalidraw assets: ${error.message}\n`)
  process.exit(1)
})
