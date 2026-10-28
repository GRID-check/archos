/**
 * Build the MCP Apps views Piloti's door serves (ADR-0142): one self-contained
 * HTML document per `ui://` resource, written to `mcp-app-views/`.
 *
 *   Usage:
 *     bun scripts/build-mcp-app-views.ts            # into mcp-app-views/
 *     bun scripts/build-mcp-app-views.ts --out DIR  # elsewhere (the specs)
 *
 * A host draws the document in a sandboxed iframe under the strict default CSP
 * (MCP Apps 2026-01-26: `default-src 'none'`, inline script and style only,
 * `connect-src 'none'`), so everything is inline: the script bundled by Bun,
 * the stylesheet compiled by Tailwind from `view.css`, no URL to fetch. The
 * document is the same for every office and every person: data reaches it only
 * through the tool result the host hands the view.
 *
 * Run by `bun run build` before `next build` and by `bun run dev:next`; the
 * output is not committed (`.gitignore`). `next build` does not bundle it: the
 * door reads the file at request time (`viewDocument` in `lib/agent-api/mcp-apps.ts`).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import { APP_VIEWS } from '../src/lib/agent-api/catalog/app-views'

/** The slice of Bun's build API this script uses; `@types/bun` is not installed (Bun is the toolchain here, ADR-0103). */
interface BunResolveArgs {
  readonly path: string
  readonly importer: string
}
interface BunPlugin {
  readonly name: string
  setup(build: { onResolve(options: { filter: RegExp }, resolve: (args: BunResolveArgs) => { path: string } | undefined): void }): void
}
interface BunBuildOutput {
  readonly path: string
  text(): Promise<string>
}
declare const Bun: {
  build(options: Record<string, unknown>): Promise<{ success: boolean; logs: readonly unknown[]; outputs: readonly BunBuildOutput[] }>
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Each view of the catalog (`APP_VIEWS`, `catalog/app-views.ts`): its document
 * is its `file`, its code lives in `src/features/mcp-apps/<name>/`, entered at
 * `main.tsx` and styled by `view.css`.
 */
const VIEWS = APP_VIEWS.map((view) => ({
  file: view.file,
  title: view.title,
  entry: `src/features/mcp-apps/${view.name}/main.tsx`,
  css: `src/features/mcp-apps/${view.name}/view.css`,
}))

/** A script inlined in HTML must not close its own element. */
const inlineScript = (code: string): string => code.replace(/<\/script/gi, '<\\/script')
const inlineStyle = (css: string): string => css.replace(/<\/style/gi, '<\\/style')

/**
 * Modules a view never needs whole, resolved to a small stand-in: the answer's
 * Markdown renderer, which the A2UI catalog imports for its `Text` leaf and
 * which carries mermaid, KaTeX and the chat stores (~7 MB). Why it is safe is
 * in the stand-in's own header. The dictionaries need none: each component
 * imports the namespace it reads (`src/i18n/namespace.ts`), so a view bundles
 * the copy it draws and no other.
 */
const STAND_INS: ReadonlyArray<{ filter: RegExp; path: string }> = [
  { filter: /MarkdownRenderer\/MarkdownRenderer$/, path: 'src/features/mcp-apps/markdown-stand-in.tsx' },
]

const standIns: BunPlugin = {
  name: 'mcp-app-view-stand-ins',
  setup(build) {
    for (const { filter, path } of STAND_INS) {
      build.onResolve({ filter }, () => ({ path: join(ROOT, path) }))
    }
  },
}

async function bundleScript(entry: string): Promise<{ js: string; css: string }> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, entry)],
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: false,
    sourcemap: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    tsconfig: join(ROOT, 'tsconfig.json'),
    plugins: [standIns],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`could not bundle ${entry}`)
  }
  const js: string[] = []
  const css: string[] = []
  for (const output of result.outputs) {
    if (output.path.endsWith('.js')) js.push(await output.text())
    else if (output.path.endsWith('.css')) css.push(await output.text())
  }
  if (js.length !== 1) throw new Error(`${entry} bundled to ${js.length} scripts, not one`)
  return { js: js[0] as string, css: css.join('\n') }
}

async function compileStyles(file: string): Promise<string> {
  const from = join(ROOT, file)
  const source = await readFile(from, 'utf8')
  const result = await postcss([tailwind({ base: dirname(from), optimize: { minify: true } })]).process(source, { from })
  return result.css
}

function documentOf(title: string, js: string, css: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${inlineStyle(css)}</style>`,
    '</head>',
    '<body>',
    '<div id="root"></div>',
    `<script type="module">${inlineScript(js)}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

async function main(): Promise<void> {
  const at = process.argv.indexOf('--out')
  const outDir = at > 0 && process.argv[at + 1] ? resolve(process.argv[at + 1] as string) : join(ROOT, 'mcp-app-views')
  await mkdir(outDir, { recursive: true })
  for (const view of VIEWS) {
    const started = Date.now()
    const [{ js, css: bundledCss }, css] = await Promise.all([bundleScript(view.entry), compileStyles(view.css)])
    const html = documentOf(view.title, js, `${css}\n${bundledCss}`)
    await writeFile(join(outDir, view.file), html)
    const kib = (Buffer.byteLength(html) / 1024).toFixed(0)
    console.log(`mcp-app-views: ${view.file} ${kib} KiB in ${Date.now() - started} ms`)
  }
}

await main()
