import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The directories that hold the app's source: what `src/` was before ADR-0145
 * row 9 split it. A spec that walks "all production code" walks these.
 */
export const SOURCE_DIRS = ['app', 'bff', 'ui', 'i18n', 'shared', 'types', 'utils'] as const

/** The source directories as absolute paths under `root` (the app root by default). */
export function sourceRoots(root: string = process.cwd()): string[] {
  return SOURCE_DIRS.map((dir) => join(root, dir))
}

/**
 * Where each top-level directory of the old `src/` lives now. The coverage
 * specs key their allowlists by `lib/documents/x.ts`, the path an `@/lib/...`
 * import spells, so they keep that key space and translate at the file system:
 * {@link srcKey} for a file, {@link srcPath} for a key.
 */
const MOVED: Record<string, string> = {
  lib: 'bff',
  features: 'ui/features',
  components: 'ui/components',
  hooks: 'ui/hooks',
  styles: 'ui/styles',
  adapters: 'ui/adapters',
  'test-utils': 'tests/test-utils',
  mocks: 'tests/mocks',
}

/** The file for a key like `lib/documents/x.ts`, under the app root. */
export function srcPath(key: string, root: string = process.cwd()): string {
  const [head, ...rest] = key.split('/')
  return join(root, MOVED[head] ?? head, ...rest)
}

/** The key (`lib/documents/x.ts`) for a file under the app root. */
export function srcKey(file: string, root: string = process.cwd()): string {
  const path = relative(root, file).replace(/\\/g, '/')
  for (const [key, moved] of Object.entries(MOVED)) {
    if (path === moved || path.startsWith(`${moved}/`)) return `${key}${path.slice(moved.length)}`
  }
  return path
}

/**
 * Every entry under the source directories as a key, the shape
 * `readdirSync(src, { recursive: true })` returned (directories included).
 */
export function srcEntries(root: string = process.cwd()): string[] {
  return sourceRoots(root).flatMap((dir) =>
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((entry) => !entry.split(/[\\/]/).includes('node_modules'))
      .map((entry) => srcKey(join(dir, entry), root)),
  )
}

/** `srcPath` for parts: `srcJoin('features', 'chat', 'x.tsx')` is `ui/features/chat/x.tsx`. */
export function srcJoin(...parts: string[]): string {
  return srcPath(parts.join('/'))
}
