import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { EMPTY_FASSUNG, type FassungFacts, type FassungRef } from '@/lib/documents/fassung'
import type { FileItem } from '../file-types'
import { FassungCount, OlderFassungBadge, isOlderFassungEntry } from './fassung-badge'

const ref = (id: string): FassungRef => ({ id, filename: `${id}.pdf` })

const doc = (fassung: FassungFacts | null): FileItem =>
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
    fassung,
  }) as FileItem

/** A current Fassung that replaces `count - 1` older ones, as the BFF's history walk reports them. */
const current = (olderCount: number): FassungFacts => ({
  ...EMPTY_FASSUNG,
  supersedes: [ref('v1')],
  history: Array.from({ length: olderCount }, (_, index) => ({
    ...ref(`older-${index}`),
    createdAt: null,
    changeSummary: null,
  })),
})

describe('FassungCount', () => {
  it('shows nothing for a document without Fassungen', () => {
    const { container } = render(<FassungCount file={doc(null)} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('counts the document with its older Fassungen, in the plural, and says so on hover', () => {
    render(<FassungCount file={doc(current(2))} />)
    expect(screen.getByTestId('fassung-count')).toHaveTextContent('3 revisions')
    expect(screen.getByTestId('fassung-count')).toHaveAttribute('title', '3 revisions of this document')
  })

  it('counts two states for a history of one older revision', () => {
    render(<FassungCount file={doc(current(1))} />)
    expect(screen.getByTestId('fassung-count')).toHaveTextContent('2 revisions')
  })

  it('counts the direct links when the surface carries no history', () => {
    render(<FassungCount file={doc({ ...EMPTY_FASSUNG, supersedes: [ref('a'), ref('b')] })} />)
    expect(screen.getByTestId('fassung-count')).toHaveTextContent('3 revisions')
  })

  it('does not count an older Fassung: its count would read as the document\'s', () => {
    const older = doc({ ...EMPTY_FASSUNG, supersededBy: ref('newer'), supersedes: [ref('oldest')] })
    const { container } = render(<FassungCount file={older} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('OlderFassungBadge', () => {
  it('shows nothing for a current Fassung', () => {
    const { container } = render(<OlderFassungBadge file={doc(current(2))} />)
    expect(container).toBeEmptyDOMElement()
    expect(isOlderFassungEntry(doc(current(2)))).toBe(false)
  })

  it('marks an older Fassung once, naming what replaced it', () => {
    const older = doc({ ...EMPTY_FASSUNG, supersededBy: ref('newer') })
    render(<OlderFassungBadge file={older} />)
    const badge = screen.getByTestId('fassung-badge')
    expect(badge).toHaveTextContent('Older revision')
    expect(badge).toHaveAttribute('data-state', 'older')
    expect(badge).toHaveAttribute('title', 'Replaced by “newer.pdf”')
    expect(isOlderFassungEntry(older)).toBe(true)
  })
})
