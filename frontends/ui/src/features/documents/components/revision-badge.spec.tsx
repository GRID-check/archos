import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { EMPTY_REVISION_LINKS, type RevisionLinks, type RevisionRef } from '@/lib/documents/revision-links'
import type { FileItem } from '../file-types'
import { RevisionCount, OlderRevisionBadge, isOlderRevisionEntry } from './revision-badge'

const ref = (id: string): RevisionRef => ({ id, filename: `${id}.pdf` })

const doc = (revision: RevisionLinks | null): FileItem =>
  ({
    id: 'doc',
    filename: 'doc.pdf',
    displayName: null,
    fileSize: 1,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    topics: null,
    capture: null,
    revision,
  }) as FileItem

/** A current Fassung that replaces `count - 1` older ones, as the BFF's history walk reports them. */
const current = (olderCount: number): RevisionLinks => ({
  ...EMPTY_REVISION_LINKS,
  supersedes: [ref('v1')],
  history: Array.from({ length: olderCount }, (_, index) => ({
    ...ref(`older-${index}`),
    createdAt: null,
    changeSummary: null,
  })),
})

describe('RevisionCount', () => {
  it('shows nothing for a document without Fassungen', () => {
    const { container } = render(<RevisionCount file={doc(null)} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('counts the document with its older Fassungen, in the plural, and says so on hover', () => {
    render(<RevisionCount file={doc(current(2))} />)
    expect(screen.getByTestId('revision-count')).toHaveTextContent('3 revisions')
    expect(screen.getByTestId('revision-count')).toHaveAttribute('title', '3 revisions of this document')
  })

  it('counts two states for a history of one older revision', () => {
    render(<RevisionCount file={doc(current(1))} />)
    expect(screen.getByTestId('revision-count')).toHaveTextContent('2 revisions')
  })

  it('counts the direct links when the surface carries no history', () => {
    render(<RevisionCount file={doc({ ...EMPTY_REVISION_LINKS, supersedes: [ref('a'), ref('b')] })} />)
    expect(screen.getByTestId('revision-count')).toHaveTextContent('3 revisions')
  })

  it('does not count an older Fassung: its count would read as the document\'s', () => {
    const older = doc({ ...EMPTY_REVISION_LINKS, supersededBy: ref('newer'), supersedes: [ref('oldest')] })
    const { container } = render(<RevisionCount file={older} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('OlderRevisionBadge', () => {
  it('shows nothing for a current Fassung', () => {
    const { container } = render(<OlderRevisionBadge file={doc(current(2))} />)
    expect(container).toBeEmptyDOMElement()
    expect(isOlderRevisionEntry(doc(current(2)))).toBe(false)
  })

  it('marks an older Fassung once, naming what replaced it', () => {
    const older = doc({ ...EMPTY_REVISION_LINKS, supersededBy: ref('newer') })
    render(<OlderRevisionBadge file={older} />)
    const badge = screen.getByTestId('revision-badge')
    expect(badge).toHaveTextContent('Older revision')
    expect(badge).toHaveAttribute('data-state', 'older')
    expect(badge).toHaveAttribute('title', 'Replaced by “newer.pdf”')
    expect(isOlderRevisionEntry(older)).toBe(true)
  })
})
