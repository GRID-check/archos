import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test-utils'
import { server } from '@/mocks/server'
import {
  PROPOSAL_ID,
  proposalBase,
  resetKit,
  useFakeStream,
} from '@/features/grid-cards/components/proposal-test-kit'
import type { ProposedChangeView } from '@/lib/proposals/types'
import { FilingSuggestionsProvider, FilingSuggestionSlot, folderLeaf, useFilingHighlighted } from './filing-suggestion'
import { FileCard } from './file-card'
import { FileListView } from './file-list-view'
import type { FileItem } from './project-file-workspace'
import { suggestionsByDocument, suggestionsByFolder, type FilingSuggestionView } from '../lib/filing-suggestions'

type FileProposal = Extract<ProposedChangeView, { kind: 'file_operation' }>

const proposal = (patch: Partial<FileProposal> = {}): FileProposal => ({
  ...proposalBase({ originConversationId: null, originMessageId: null }),
  kind: 'file_operation',
  payload: {
    operation: 'move',
    operations: [
      { document: 'MA37_Bescheid.pdf', source: 'project', target_folder: 'Behörde/Bescheide', reason: 'Ein Bescheid der MA 37.' },
      { document: 'Stellungnahme.pdf', source: 'project', target_folder: 'Behörde/Bescheide', reason: 'Eine Stellungnahme.' },
    ],
    basis: 'name',
  },
  ...patch,
})

const single = (patch: Partial<FileProposal['payload']> = {}): FileProposal =>
  proposal({
    payload: {
      operation: 'move',
      operations: [{ document: 'MA37_Bescheid.pdf', source: 'project', target_folder: 'Korrespondenz', reason: 'Ein Brief.' }],
      basis: 'name',
      ...patch,
    },
  })

const DOCUMENTS = [
  { id: 'doc_1', name: 'MA37_Bescheid.pdf' },
  { id: 'doc_2', name: 'Stellungnahme.pdf' },
]

/** Lit or not, as a card asks. */
function Lit({ id }: { id: string }) {
  return <span data-testid={`lit-${id}`}>{useFilingHighlighted(id) ? 'lit' : 'dark'}</span>
}

function renderSlot(
  listed: FileProposal,
  { documentId = 'doc_1', onSettled = vi.fn(), folderPathOf = (): string | undefined => '', onCardClick = vi.fn() } = {}
) {
  const entries = [{ proposal: listed, documents: listed.payload.operations.length > 1 ? DOCUMENTS : DOCUMENTS.slice(0, 1) }]
  render(
    <FilingSuggestionsProvider
      byDocument={suggestionsByDocument(entries)}
      byFolder={suggestionsByFolder(entries)}
      onSettled={onSettled}
      folderPathOf={folderPathOf}
    >
      {/* What the chip sits on: a card or a row that opens the file on click. */}
      <div onClick={onCardClick} onKeyDown={onCardClick} data-testid="host">
        <FilingSuggestionSlot documentId={documentId} />
      </div>
      <Lit id="doc_1" />
      <Lit id="doc_2" />
    </FilingSuggestionsProvider>
  )
  return { onSettled, onCardClick }
}

let current: FileProposal

beforeEach(() => {
  useFakeStream()
  current = proposal()
  server.use(
    http.get(`/api/proposals/${PROPOSAL_ID}`, () => HttpResponse.json({ proposal: current })),
    http.post(`/api/proposals/${PROPOSAL_ID}/apply`, () => {
      current = {
        ...current,
        status: 'applied',
        decidedBy: 'user_me',
        decidedAt: '2026-10-13T09:00:00.000Z',
        canDecide: false,
        results: current.payload.operations.map((item) => ({ label: item.document ?? '', ok: true })),
      }
      return HttpResponse.json({ proposal: current })
    }),
    http.post(`/api/proposals/${PROPOSAL_ID}/dismiss`, () => {
      current = { ...current, status: 'dismissed', decidedBy: 'user_me', decidedAt: '2026-10-13T09:00:00.000Z', canDecide: false }
      return HttpResponse.json({ proposal: current })
    })
  )
})

afterEach(() => {
  resetKit()
})

const chip = () => screen.getByRole('button', { name: 'Filing suggestion: Behörde/Bescheide' })

describe('FilingChip', () => {
  it('names the folder’s last segment, opens a dialog, and reads nothing from the server until opened', () => {
    const gets = vi.fn()
    server.events.on('request:start', ({ request }) => gets(request.url))
    renderSlot(current)
    expect(chip()).toHaveTextContent('→ Bescheide')
    expect(chip()).toHaveAttribute('aria-haspopup', 'dialog')
    expect(chip()).toHaveAttribute('aria-expanded', 'false')
    // Calm: the dashed hairline on the card surface, no fill colour of its own.
    expect(chip().className).toContain('border-dashed')
    expect(chip().className).toContain('bg-card')
    expect(gets).not.toHaveBeenCalled()
  })

  it('marks a folder the move creates as new, and never cuts the glyph', () => {
    current = single({ new_folder: { path: 'Korrespondenz', description: 'Briefe' } })
    renderSlot(current)
    const newChip = screen.getByRole('button', { name: 'Filing suggestion: Korrespondenz' })
    expect(within(newChip).getByText('new')).toBeInTheDocument()
    expect(newChip.querySelector('[data-slot="agent-glyph"]')?.className).toContain('shrink-0')
  })

  it('draws nothing for a file Piloti has nothing to say about', () => {
    renderSlot(current, { documentId: 'doc_elsewhere' })
    expect(screen.queryByTestId('filing-chip')).not.toBeInTheDocument()
  })
})

describe('the popover the chip opens', () => {
  it('shows the move as a before and an after, the reason, and that the one click moves the other file too', async () => {
    renderSlot(current, { folderPathOf: () => 'Eingang' })
    await userEvent.click(chip())
    const dialog = await screen.findByRole('dialog', { name: 'Filing suggestion from Piloti' })
    expect(within(dialog).getByText('Eingang').closest('s')).not.toBeNull()
    expect(within(dialog).getByText('Behörde/Bescheide')).toBeInTheDocument()
    expect(within(dialog).getByText('Ein Bescheid der MA 37.')).toBeInTheDocument()
    expect(within(dialog).getByText('with 1 more file')).toBeInTheDocument()
    expect(await within(dialog).findByRole('button', { name: 'Move all 2' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Leave it' })).toBeInTheDocument()
  })

  it('names the top level of the shelf for a file at the root', async () => {
    renderSlot(current, { folderPathOf: () => '' })
    await userEvent.click(chip())
    expect(await screen.findByText('Project folder (top level)')).toBeInTheDocument()
  })

  it('names the Büroablage’s top level on that shelf', async () => {
    current = proposal({
      payload: {
        ...proposal().payload,
        operations: proposal().payload.operations.map((item) => ({ ...item, source: 'office' as const })),
      },
    })
    renderSlot(current, { folderPathOf: () => '' })
    await userEvent.click(chip())
    expect(await screen.findByText('Office filing (top level)')).toBeInTheDocument()
  })

  it('lights the other file the proposal moves while it is open, and only then', async () => {
    renderSlot(current)
    expect(screen.getByTestId('lit-doc_2')).toHaveTextContent('dark')
    await userEvent.click(chip())
    expect(screen.getByTestId('lit-doc_2')).toHaveTextContent('lit')
    // Its own file is the one the person is looking at.
    expect(screen.getByTestId('lit-doc_1')).toHaveTextContent('dark')
    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('lit-doc_2')).toHaveTextContent('dark')
  })

  it('closes on Escape and gives focus back to the chip', async () => {
    renderSlot(current)
    await userEvent.click(chip())
    await screen.findByRole('dialog')
    expect(chip()).toHaveAttribute('aria-expanded', 'true')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(chip()).toHaveFocus()
  })

  it('keeps every click and key inside it, and on the chip, from the card underneath', async () => {
    const { onCardClick } = renderSlot(current)
    await userEvent.click(chip())
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByText('Ein Bescheid der MA 37.'))
    await userEvent.keyboard('{Enter}')
    expect(onCardClick).not.toHaveBeenCalled()
  })

  it('moves the files with one click, through the proposal, and tells the shelf to re-read', async () => {
    const { onSettled } = renderSlot(current)
    await userEvent.click(chip())
    await userEvent.click(await screen.findByRole('button', { name: 'Move all 2' }))
    expect(await screen.findByText('Moved to “Behörde/Bescheide”.')).toBeInTheDocument()
    await waitFor(() => expect(onSettled).toHaveBeenCalled())
  })

  it('leaves it with the other click, as a dismissal of the proposal', async () => {
    const { onSettled } = renderSlot(current)
    await userEvent.click(chip())
    await userEvent.click(await screen.findByRole('button', { name: 'Leave it' }))
    expect(await screen.findByText('Stays where it is.')).toBeInTheDocument()
    await waitFor(() => expect(onSettled).toHaveBeenCalled())
  })

  it('says “Move” for one file, and “Create and move” for a folder that does not exist yet', async () => {
    current = single()
    renderSlot(current)
    await userEvent.click(screen.getByRole('button', { name: 'Filing suggestion: Korrespondenz' }))
    expect(await screen.findByRole('button', { name: 'Move' })).toBeInTheDocument()
    expect(screen.queryByText('with 1 more file')).not.toBeInTheDocument()
  })

  it('offers to create a folder that does not exist yet, in the same one click', async () => {
    current = single({ new_folder: { path: 'Korrespondenz', description: 'Briefe' } })
    renderSlot(current)
    await userEvent.click(screen.getByRole('button', { name: 'Filing suggestion: Korrespondenz' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('new')).toBeInTheDocument()
    expect(await within(dialog).findByRole('button', { name: 'Create and move' })).toBeInTheDocument()
  })

  it('shows a reader who may not move it the path and the reason, and no buttons', async () => {
    current = proposal({ canDecide: false })
    renderSlot(current)
    await userEvent.click(chip())
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Only people who may file here can move it.')).toBeInTheDocument()
    expect(within(dialog).getByText('Behörde/Bescheide')).toBeInTheDocument()
    expect(within(dialog).getByText('Ein Bescheid der MA 37.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button')).not.toBeInTheDocument()
  })
})

const listed = (id: string, filename: string): FileItem => ({
  id,
  filename,
  displayName: null,
  fileSize: 1_000,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-06-01T09:00:00Z',
  errorMessage: null,
  summary: 'Eine Zusammenfassung.',
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
})

function Shelf({ children }: { children: ReactNode }) {
  const entries = [{ proposal: current, documents: DOCUMENTS }]
  return (
    <FilingSuggestionsProvider byDocument={suggestionsByDocument(entries)} byFolder={suggestionsByFolder(entries)} onSettled={vi.fn()}>
      {children}
    </FilingSuggestionsProvider>
  )
}

describe('FilingChip on the card', () => {
  it('keeps the tile’s structure and height classes, with no block of its own in the footer', () => {
    render(
      <Shelf>
        <FileCard file={listed('doc_1', 'MA37_Bescheid.pdf')} isSelected={false} onSelect={vi.fn()} locale="en" testId="with" />
        <FileCard file={listed('doc_other', 'Einreichplan.pdf')} isSelected={false} onSelect={vi.fn()} locale="en" testId="without" />
      </Shelf>
    )
    const [withFooter, withoutFooter] = screen.getAllByTestId('file-card-footer')
    const shellOf = (footer: HTMLElement) => footer.parentElement!
    // The same tile: shell, card button and footer carry the same classes and the same parts.
    expect(shellOf(withFooter).className).toBe(shellOf(withoutFooter).className)
    expect(shellOf(withFooter).children).toHaveLength(shellOf(withoutFooter).children.length)
    expect(screen.getByTestId('with').className).toBe(screen.getByTestId('without').className)
    expect(withFooter.className).toBe(withoutFooter.className)
    expect(withFooter.children).toHaveLength(withoutFooter.children.length)
    // The chip is in the footer's left slot, and nothing else was added.
    const [lead] = Array.from(withFooter.children)
    expect(lead.children).toHaveLength(1)
    expect(within(withFooter).getByTestId('filing-chip')).toBe(lead.firstElementChild)
    expect(within(withoutFooter).queryByTestId('filing-chip')).not.toBeInTheDocument()
    // Its margin box is a line of text: 24px tall, minus 4px above and below.
    expect(within(withFooter).getByTestId('filing-chip').className).toMatch(/(^| )h-6( |$)/)
    expect(within(withFooter).getByTestId('filing-chip').className).toMatch(/(^| )-my-1( |$)/)
    expect(document.querySelector('[data-slot="inline-suggestion"]')).toBeNull()
    // Not inside the card's own button: a button cannot hold a button.
    expect(within(screen.getByTestId('with')).queryByTestId('filing-chip')).not.toBeInTheDocument()
  })

  it('opens the popover without opening the file', async () => {
    const onSelect = vi.fn()
    render(
      <Shelf>
        <FileCard file={listed('doc_1', 'MA37_Bescheid.pdf')} isSelected={false} onSelect={onSelect} locale="en" />
      </Shelf>
    )
    await userEvent.click(screen.getByTestId('filing-chip'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('FilingChip in the list', () => {
  it('sits right after the name, in the file’s own row, and adds no row', async () => {
    const files = [listed('doc_1', 'MA37_Bescheid.pdf'), listed('doc_other', 'Einreichplan.pdf')]
    render(
      <Shelf>
        <FileListView files={files} selectedFileId={null} onSelectFile={vi.fn()} />
      </Shelf>
    )
    const rows = screen.getAllByTestId('file-list-row')
    expect(rows).toHaveLength(2)
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2)
    const fileRow = rows.find((row) => row.textContent?.includes('MA37_Bescheid.pdf'))!
    const chipInRow = within(fileRow).getByTestId('filing-chip')
    // The name line: the flex row holding the name, the Fassung count and the chip.
    expect(within(fileRow).getByText('MA37_Bescheid.pdf').closest('.items-baseline')).toBe(chipInRow.parentElement)
    expect(screen.getAllByTestId('filing-chip')).toHaveLength(1)
  })

  it('opens its popover without selecting the row', async () => {
    const onSelectFile = vi.fn()
    render(
      <Shelf>
        <FileListView files={[listed('doc_1', 'MA37_Bescheid.pdf')]} selectedFileId={null} onSelectFile={onSelectFile} />
      </Shelf>
    )
    await userEvent.click(screen.getByTestId('filing-chip'))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Leave it' }))
    expect(onSelectFile).not.toHaveBeenCalled()
  })
})

describe('folderLeaf', () => {
  it('is the last segment of a path', () => {
    expect(folderLeaf('Behörde/Bescheide')).toBe('Bescheide')
    expect(folderLeaf('Korrespondenz')).toBe('Korrespondenz')
    expect(folderLeaf('A/B/')).toBe('B')
  })
})

describe('suggestionsByDocument', () => {
  const view = (byDocument: Map<string, FilingSuggestionView>, id: string) => byDocument.get(id)

  it('keys each file of a filing suggestion by its document, with its own reason', () => {
    const byDocument = suggestionsByDocument([{ proposal: proposal(), documents: DOCUMENTS }])
    expect(view(byDocument, 'doc_2')).toEqual({
      proposalId: PROPOSAL_ID,
      folder: 'Behörde/Bescheide',
      reason: 'Eine Stellungnahme.',
      isNew: false,
      basis: 'name',
      fileCount: 2,
      canDecide: true,
      shelf: 'project',
      documentIds: ['doc_1', 'doc_2'],
    })
  })

  it('leaves out a chat’s proposal, a decided one, and every other kind', () => {
    const fromChat = proposal({ originConversationId: 'conv-1' })
    const decided = proposal({ status: 'dismissed' })
    const withoutBasis = proposal({ payload: { ...proposal().payload, basis: null } })
    expect(
      suggestionsByDocument([
        { proposal: fromChat, documents: DOCUMENTS },
        { proposal: decided, documents: DOCUMENTS },
        { proposal: withoutBasis, documents: DOCUMENTS },
      ]).size
    ).toBe(0)
  })
})

describe('suggestionsByFolder', () => {
  it('lists one entry per target folder with the files that go there, and applies the same rules as the rows', () => {
    const second = proposal({
      id: '00000000-0000-4000-8000-0000000000a2',
      payload: {
        operation: 'move',
        operations: [{ document: 'Brief.pdf', source: 'project', target_folder: 'Korrespondenz', reason: 'Ein Brief.' }],
        basis: 'content',
        new_folder: { path: 'Korrespondenz', description: 'Briefe' },
      },
    })
    const fromChat = proposal({ id: '00000000-0000-4000-8000-0000000000a3', originConversationId: 'conv-1' })
    const entries = suggestionsByFolder([
      { proposal: proposal(), documents: DOCUMENTS },
      { proposal: second, documents: [{ id: 'doc_3', name: 'Brief.pdf' }] },
      { proposal: fromChat, documents: DOCUMENTS },
    ])
    expect(entries.map((entry) => [entry.suggestion.folder, entry.suggestion.isNew, entry.documents.map((d) => d.name)])).toEqual([
      ['Behörde/Bescheide', false, ['MA37_Bescheid.pdf', 'Stellungnahme.pdf']],
      ['Korrespondenz', true, ['Brief.pdf']],
    ])
    expect(entries[0].suggestion).toMatchObject({ fileCount: 2, reason: 'Ein Bescheid der MA 37.', proposalId: PROPOSAL_ID })
  })
})
