// @disk-inputs: src/**
/**
 * @vitest-environment node
 *
 * Text written for a log must not reach a person's screen.
 *
 * Every error string the server, the knowledge layer or a transport writes is
 * English and meant for whoever reads the log: an API envelope's `error`, a
 * stored ingest failure (`pdf_pages_unreadable: 7 of 12 pages could not be
 * read`), an exception's `.message`. A German office onboarding Piloti read
 * such strings in the middle of its project setup and reported that „the
 * language jumped to English" (19.10.2026). The words have to come from the
 * dictionary, with the raw text in the console or behind a „Details" disclosure.
 *
 * This reads the source and refuses the two shapes that put it on screen:
 *
 *  - a stored `errorMessage` rendered as a JSX child: say it through
 *    `IngestFailureNotice` (an ingest failure) or write a dictionary sentence
 *    into it (`features/documents/lib/upload-failure.ts`, an upload's);
 *  - a toast built from a response body's `error`: toast the dictionary key,
 *    and `console.warn` the body.
 *
 * Each allowance names why its text is already the reader's language, or why
 * it is debt off the project path. Shrink the lists; do not grow them.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..')

/** `{file.errorMessage}` as a child, not as a prop value (`message={…}`). */
const ERROR_MESSAGE_CHILD = /(?<!=)\{\s*[\w.?]+\.errorMessage\s*\}/
/** `toast.error(body?.error ?? …)`, `toast.error(data.error)`. */
const TOAST_OF_BODY = /toast\.(?:error|warning|info|message)\(\s*\w+\??\.error\b/

const ERROR_MESSAGE_CHILD_ALLOWED: Record<string, string> = {
  'features/documents/components/upload-tray.tsx':
    'the upload-failure branch only: use-file-upload writes that text through uploadFailureSentence (dictionary); the ingest branch goes through IngestFailureNotice',
  'features/documents/components/FileUploadZone.tsx':
    'the upload-failure branch only, as in upload-tray; the ingest branch goes through IngestFailureNotice',
}

const TOAST_OF_BODY_ALLOWED: Record<string, string> = {
  'features/platform/components/norm-registry.tsx': 'platform staff surface, off the project path: known debt',
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'dev' ? [] : sourceFiles(path)
    if (!/\.tsx?$/.test(name) || /\.(spec|test)\.tsx?$/.test(name)) return []
    return [path]
  })
}

const files = sourceFiles(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }))

function offenders(pattern: RegExp, allowed: Record<string, string>): string[] {
  return files.flatMap(({ path, text }) =>
    text
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => pattern.test(line) && !(path in allowed))
      .map(({ line, index }) => `${path}:${index + 1}: ${line.trim()}`)
  )
}

describe('raw error text on screen', () => {
  it('renders no stored errorMessage as text outside the surfaces that write it from the dictionary', () => {
    expect(offenders(ERROR_MESSAGE_CHILD, ERROR_MESSAGE_CHILD_ALLOWED)).toEqual([])
  })

  it('toasts no response body’s English error', () => {
    expect(offenders(TOAST_OF_BODY, TOAST_OF_BODY_ALLOWED)).toEqual([])
  })

  it('keeps every allowance live, so a fixed file leaves the list', () => {
    const stale = [
      ...Object.keys(ERROR_MESSAGE_CHILD_ALLOWED).filter(
        (path) => !files.some((file) => file.path === path && ERROR_MESSAGE_CHILD.test(file.text))
      ),
      ...Object.keys(TOAST_OF_BODY_ALLOWED).filter(
        (path) => !files.some((file) => file.path === path && TOAST_OF_BODY.test(file.text))
      ),
    ]
    expect(stale).toEqual([])
  })

  it('catches the shapes it is meant to catch', () => {
    expect(ERROR_MESSAGE_CHILD.test('<p className="text-error">{file.errorMessage}</p>')).toBe(true)
    expect(ERROR_MESSAGE_CHILD.test('<Notice errorMessage={file.errorMessage} />')).toBe(false)
    expect(TOAST_OF_BODY.test("toast.error(body?.error ?? t('x'))")).toBe(true)
    expect(TOAST_OF_BODY.test("toast.error(t('x'))")).toBe(false)
  })
})
