/**
 * The folder brief as a reader meets it: the numbers add up, what needs them
 * comes first, the rest is folded to one line, and a long chip never breaks the
 * card. What is counted is specced in `../lib/folder-knowledge.spec.ts`.
 *
 * English, the default locale of an unprovided test tree.
 */

import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { EMPTY_FASSUNG } from '@/lib/documents/fassung'
import type { FileItem, FolderItem } from '../file-types'
import { buildFolderBrief } from '../lib/folder-knowledge'
import { FolderBrief } from './folder-brief'

let seq = 0
const file = (overrides: Partial<FileItem>): FileItem => ({
  id: `f${(seq += 1)}`,
  filename: 'doc.pdf',
  displayName: null,
  fileSize: 1,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: 'P',
  createdAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
  ...overrides,
})

const FOLDERS: FolderItem[] = [{ id: 'P', parentId: null, name: 'Pläne', path: 'Pläne' }]
const LONG_TOPIC = 'Brandabschnittsbildung zwischen Tiefgarage'

/** Three read, one failed, one held, one report Piloti never reads: 5 meant to read, 6 in all. */
const CORPUS: FileItem[] = [
  file({ tags: ['Grundriss', 'Brandschutz'], topics: [LONG_TOPIC] }),
  file({ tags: ['Grundriss'] }),
  file({ tags: ['Schnitt'] }),
  file({ status: 'failed' }),
  file({ status: 'quarantined' }),
  file({ status: 'stored' }),
]

const renderBrief = (
  files: FileItem[] = CORPUS,
  props: Partial<ComponentProps<typeof FolderBrief>> = {}
) => {
  const onSelect = vi.fn()
  render(
    <FolderBrief
      brief={buildFolderBrief(files, FOLDERS, null)}
      folderName={null}
      shelfKind="project"
      onSelect={onSelect}
      onOpenFolder={vi.fn()}
      onReadAgain={vi.fn()}
      collapsed={false}
      onCollapsedChange={vi.fn()}
      missing={[{ role: 'grundbuchauszug', label: 'Land register extract', bauwerkName: null }]}
      {...props}
    />
  )
  return { onSelect }
}

describe('FolderBrief — the numbers add up', () => {
  it('puts only the documents Piloti is meant to read in the legend, so it sums to the headline', () => {
    renderBrief()
    expect(screen.getByText(/3 of 5 documents read/)).toBeInTheDocument()
    const legendCounts = ['readable', 'failed', 'held'].map((state) =>
      Number(screen.getByTestId(`folder-brief-state-${state}`).textContent?.match(/\d+/)?.[0])
    )
    expect(legendCounts.reduce((a, b) => a + b, 0)).toBe(5)
    // The report is named beside the legend, plainly as an extra.
    expect(screen.getByTestId('folder-brief-state-unindexed')).toHaveTextContent(
      'plus 1 not in the knowledge base'
    )
  })

  it('counts one document with three Fassungen once, and never asks to re-read a replaced one', () => {
    const ref = (id: string) => ({ id, filename: `${id}.pdf` })
    renderBrief([
      file({ id: 'c', tags: ['Grundriss'], fassung: { ...EMPTY_FASSUNG, supersedes: [ref('b')] } }),
      file({
        id: 'b',
        status: 'failed',
        fassung: { ...EMPTY_FASSUNG, supersededBy: ref('c'), supersedes: [ref('a')] },
      }),
      file({ id: 'a', fassung: { ...EMPTY_FASSUNG, supersededBy: ref('b') } }),
    ])
    expect(screen.getByText(/The document is read/)).toBeInTheDocument()
    expect(screen.queryByTestId('folder-brief-needs-failed')).not.toBeInTheDocument()
    expect(screen.queryByTestId('folder-brief-read-again')).not.toBeInTheDocument()
  })
})

describe('FolderBrief — what needs the reader comes first', () => {
  it('orders the body by what the reader has to do, and folds the reference sections', () => {
    renderBrief()
    const body = document.getElementById('folder-brief-body')!
    const order = [...body.children].map(
      (section) => section.getAttribute('data-testid') ?? section.getAttribute('aria-labelledby')
    )
    expect(order).toEqual([
      'folder-brief-needs',
      'folder-brief-missing',
      'folder-brief-about',
      'folder-brief-where',
    ])
    expect(screen.getByTestId('folder-brief-about')).toHaveAttribute('data-state', 'closed')
    expect(screen.queryByTestId('folder-brief-types')).not.toBeInTheDocument()
  })

  it('names what a folded section holds on its one line, and opens on a click', async () => {
    renderBrief()
    const toggle = screen.getByTestId('folder-brief-about-toggle')
    expect(toggle).toHaveTextContent('Grundriss · Schnitt · Brandschutz')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('folder-brief-types')).toBeInTheDocument()
  })

  it('gives each „Show" its own accessible name', () => {
    renderBrief()
    expect(
      within(screen.getByTestId('folder-brief-needs-failed')).getByRole('button', {
        name: 'Show the failed document',
      })
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('folder-brief-needs-held')).getByRole('button', {
        name: 'Show the held-back document',
      })
    ).toBeInTheDocument()
  })
})

describe('FolderBrief — chips', () => {
  it('labels the type and discipline families, so they are told apart by a word', async () => {
    renderBrief()
    await userEvent.click(screen.getByTestId('folder-brief-about-toggle'))
    const types = screen.getByTestId('folder-brief-types')
    expect(within(types).getByText('Document type')).toBeInTheDocument()
    expect(within(types).getByText('Discipline')).toBeInTheDocument()
  })

  it('truncates a long topic inside the chip, keeps its count, and carries the full text on hover', async () => {
    renderBrief()
    await userEvent.click(screen.getByTestId('folder-brief-about-toggle'))
    const chip = screen.getByTestId(`folder-brief-topic-${LONG_TOPIC}`)
    expect(chip).toHaveClass('max-w-full')
    expect(within(chip).getByText(LONG_TOPIC)).toHaveClass('truncate')
    expect(within(chip).getByText('1')).toBeInTheDocument()
    expect(chip.getAttribute('title')).toContain(LONG_TOPIC)
  })
})
