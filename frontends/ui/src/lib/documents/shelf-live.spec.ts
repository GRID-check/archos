// @disk-inputs: src/**
/**
 * @vitest-environment node
 */
/**
 * Every write to a shelf is announced on its live channel (`shelf:<id>`), or
 * the Files workspaces open on it go stale until a reload: that was the
 * workspace before the channel existed, and a new write path that forgets the
 * announcement brings it back for exactly that path.
 *
 * So: a module that writes the `documents` or `project_folders` table either
 * calls `publishShelfChanged` itself, or is listed below with the module that
 * announces its writes, or with why they change nothing a shelf listing shows.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../../', import.meta.url)

const modules = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((entry) => /\.tsx?$/.test(entry) && !/\.(spec|test)\.tsx?$/.test(entry))
  .filter((entry) => !entry.includes('test-utils') && !entry.startsWith('app/dev'))
  .map((entry) => ({ path: entry.split('\\').join('/'), code: readFileSync(new URL(entry, SRC), 'utf8') }))

const WRITES_A_SHELF =
  /\.(update|insert|delete)\(\s*(documents|projectFolders)\s*\)|\b(UPDATE|INSERT INTO|DELETE FROM)\s+(documents|project_folders)\b/

/** Writers whose writes another module announces, or that change nothing a shelf listing shows. */
const ANNOUNCED_ELSEWHERE: Record<string, string> = {
  'lib/storage/repository.ts': 'the insert and the replace; `lib/storage/service.ts` and `lib/documents/shelf-upload.ts` announce them',
  'lib/office-shelf/repository.ts': 'the Archiv delete; `lib/office-shelf/service.ts` announces it',
  'lib/projects/folder-bin-repository.ts': 'binning and restoring; `lib/projects/folder-bin.ts` announces them after their transaction',
  'lib/projects/cleanup-repository.ts': 'the empty holder folder; `lib/projects/cleanup-service.ts` announces it',
  'lib/documents/version-repository.ts': 'a version’s state, its bytes and archiving; `lib/documents/lifecycle.ts` and `lib/documents/version-content.ts` announce them',
  'lib/documents/placement-repository.ts': 'which collection a document is indexed in; nothing a listing shows',
  'lib/projects/folder-derived-repository.ts': 'a derived report’s source marker; nothing a listing shows',
  'lib/session-documents/repository.ts': 'chat attachments, which are on no shelf',
}

describe('every write to a shelf', () => {
  const writers = modules.filter(({ code }) => WRITES_A_SHELF.test(code)).map(({ path, code }) => ({ path, code }))

  it('is announced on the shelf’s live channel', () => {
    const silent = writers
      .filter(({ path, code }) => !code.includes('publishShelfChanged(') && !(path in ANNOUNCED_ELSEWHERE))
      .map(({ path }) => path)
    expect(silent).toEqual([])
  })

  it('keeps the list of exceptions honest: each one still writes, and each announcer still announces', () => {
    const writing = new Set(writers.map(({ path }) => path))
    expect(Object.keys(ANNOUNCED_ELSEWHERE).filter((path) => !writing.has(path))).toEqual([])
    const announcers = [
      'lib/storage/service.ts',
      'lib/documents/shelf-upload.ts',
      'lib/office-shelf/service.ts',
      'lib/projects/folder-bin.ts',
      'lib/projects/cleanup-service.ts',
      'lib/documents/lifecycle.ts',
      'lib/documents/version-content.ts',
    ]
    const codeOf = new Map(modules.map(({ path, code }) => [path, code]))
    expect(announcers.filter((path) => !codeOf.get(path)?.includes('publishShelfChanged('))).toEqual([])
  })
})
