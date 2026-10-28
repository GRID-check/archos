/**
 * A target remembers that its document is an older Fassung.
 *
 * The stored row a citation resolves against carries the reader-visible `supersededBy`
 * (`revision.supersededBy` of the by-name listing row); the target hands it to the peek. A row nobody
 * replaced, a base-corpus file and an unresolved name carry none.
 */

import { describe, expect, test } from 'vitest'
import { buildCitationModel, resolveCitationTarget, type StoredDocumentRef } from './index'
import type { CitationSource } from '../../types'

const document = (fileName: string) => {
  const source: CitationSource = {
    id: `c-${fileName}`,
    content: `[KB] ${fileName}, p.2`,
    citationKey: `${fileName}, p.2`,
    fileName,
    collection: 'proj_1',
    shelf: 'project',
    page: 2,
    isCited: true,
    timestamp: new Date('2026-09-04T10:00:00Z'),
  }
  const [built] = buildCitationModel({ citations: [source] })
  if (!built) throw new Error('fixture produced no document')
  return built
}

const stored = (filename: string, extra: Partial<StoredDocumentRef> = {}): StoredDocumentRef => ({
  id: `id-${filename}`,
  filename,
  contentType: 'application/pdf',
  shelf: 'project',
  ...extra,
})

const NEWER = { id: 'id-c', filename: 'Statik_Index_C.pdf' }

describe('the target of a citation of an older revision', () => {
  test('a viewable document carries the newer one', () => {
    const target = resolveCitationTarget(document('Statik_Index_B.pdf'), {
      storedDocuments: [stored('Statik_Index_B.pdf', { supersededBy: NEWER })],
    })

    expect(target).toMatchObject({ kind: 'document', supersededBy: NEWER })
  })

  test('a document with no viewer carries it too, so the download chip says so as well', () => {
    const target = resolveCitationTarget(document('Statik_Index_B.dwg'), {
      storedDocuments: [stored('Statik_Index_B.dwg', { contentType: 'image/vnd.dwg', supersededBy: NEWER })],
    })

    expect(target).toMatchObject({ kind: 'download', supersededBy: NEWER })
  })

  test.each([
    ['a row nobody replaced', { supersededBy: null }],
    ['a row that says nothing', {}],
  ])('%s carries none', (_name, extra) => {
    const target = resolveCitationTarget(document('Statik_Index_C.pdf'), {
      storedDocuments: [stored('Statik_Index_C.pdf', extra)],
    })

    expect(target.kind).toBe('document')
    expect('supersededBy' in target).toBe(false)
  })

  test('the base corpus has no revisions', () => {
    const target = resolveCitationTarget(document('oib-rl_2.pdf'), { baseCorpusFiles: ['oib-rl_2.pdf'] })

    expect('supersededBy' in target).toBe(false)
  })
})
