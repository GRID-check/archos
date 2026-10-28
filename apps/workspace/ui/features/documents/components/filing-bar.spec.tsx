// @disk-inputs: ui/**
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test-utils'
import { server } from '@/mocks/server'
import { proposalBase, resetKit, useFakeStream } from '@/features/cards/components/proposal-test-kit'
import type { ListedProposal, ProposedChangeView } from '@/lib/proposals/types'
import { FilingViewBar } from './filing-bar'
import { FilingSuggestionsProvider } from './filing-suggestion'
import { FileCard } from './file-card'
import { FileListView } from './file-list-view'
import type { FileItem } from './project-file-workspace'
import { filingBarEntries, suggestionsByDocument, suggestionsByFolder } from '../lib/filing-suggestions'

type FileProposal = Extract<ProposedChangeView, { kind: 'file_operation' }>

const PERMIT_DECISIONS_ID = '00000000-0000-4000-8000-0000000000b1'
const BRIEF_ID = '00000000-0000-4000-8000-0000000000b2'

const filing = (id: string, folder: string, names: string[], patch: Partial<FileProposal['payload']> = {}): FileProposal => ({
  ...proposalBase({ id, originConversationId: null, originMessageId: null }),
  kind: 'file_operation',
  payload: {
    operation: 'move',
    operations: names.map((document) => ({ document, source: 'project' as const, target_folder: folder, reason: 'Passt.' })),
    basis: 'name',
    ...patch,
  },
})

const PERMIT_DECISIONS: ListedProposal = {
  proposal: filing(PERMIT_DECISIONS_ID, 'Behörde/Bescheide', ['MA37.pdf', 'MA22.pdf']),
  documents: [
    { id: 'doc_ma37', name: 'MA37.pdf' },
    { id: 'doc_ma22', name: 'MA22.pdf' },
  ],
}
const BRIEF: ListedProposal = {
  proposal: filing(BRIEF_ID, 'Korrespondenz', ['Brief.pdf'], { new_folder: { path: 'Korrespondenz', description: 'Briefe' } }),
  documents: [{ id: 'doc_brief', name: 'Brief.pdf' }],
}
const ONE_EACH: ListedProposal = {
  proposal: filing(PERMIT_DECISIONS_ID, 'Behörde/Bescheide', ['MA37.pdf']),
  documents: [{ id: 'doc_ma37', name: 'MA37.pdf' }],
}

const file = (id: string, filename: string): FileItem => ({
  id,
  filename,
  displayName: null,
  fileSize: 1_000,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-06-01T09:00:00Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
})

const FILES = [
  file('doc_ma37', 'MA37.pdf'),
  file('doc_ma22', 'MA22.pdf'),
  file('doc_brief', 'Brief.pdf'),
  file('doc_eg', 'EG.pdf'),
]
const IDS = FILES.map((entry) => entry.id)

let store: Map<string, FileProposal>

beforeEach(() => {
  useFakeStream()
  store = new Map([PERMIT_DECISIONS, BRIEF].map(({ proposal }) => [proposal.id, proposal as FileProposal]))
  server.use(
    http.get('/api/proposals/:id', ({ params }) => HttpResponse.json({ proposal: store.get(String(params.id)) })),
    http.post('/api/proposals/:id/apply', ({ params }) => {
      const next = { ...store.get(String(params.id))!, status: 'applied' as const, canDecide: false, results: [] }
      store.set(next.id, next)
      return HttpResponse.json({ proposal: next })
    })
  )
})

afterEach(resetKit)

function renderView(listed: ListedProposal[], { view = 'grid', minFiles }: { view?: 'grid' | 'list'; minFiles?: number } = {}) {
  const onSettled = vi.fn()
  render(
    <FilingSuggestionsProvider byDocument={suggestionsByDocument(listed)} byFolder={suggestionsByFolder(listed)} onSettled={onSettled}>
      <FilingViewBar documentIds={IDS} minFiles={minFiles} />
      {view === 'grid' ? (
        FILES.map((entry) => (
          <FileCard key={entry.id} file={entry} isSelected={false} onSelect={vi.fn()} locale="en" testId={`card-${entry.id}`} />
        ))
      ) : (
        <FileListView files={FILES} selectedFileId={null} onSelectFile={vi.fn()} />
      )}
    </FilingSuggestionsProvider>
  )
  return onSettled
}

/** The ids of the tiles outlined right now. */
const litCards = () =>
  FILES.filter((entry) => screen.getByTestId(`card-${entry.id}`).closest('[class*="rounded-xl"]')?.className.includes('outline-strong')).map(
    (entry) => entry.id
  )

describe('FilingViewBar', () => {
  it('stays away while every target folder in view collects one file: the chip decides as well', () => {
    renderView([ONE_EACH, BRIEF])
    expect(screen.queryByTestId('filing-bar')).not.toBeInTheDocument()
  })

  it('appears once a folder collects two files, and then lists every target folder of the view', async () => {
    renderView([PERMIT_DECISIONS, BRIEF])
    const bar = screen.getByTestId('filing-bar')
    expect(bar).toHaveAccessibleName('Piloti suggests filing 3 files')
    const lines = within(bar).getAllByTestId('filing-bar-line')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toHaveTextContent('Behörde/Bescheide')
    expect(lines[0]).toHaveTextContent('2 files')
    expect(await within(lines[0]).findByRole('button', { name: 'Move' })).toBeInTheDocument()
    expect(within(lines[0]).getByRole('button', { name: 'Leave it' })).toBeInTheDocument()
    expect(lines[1]).toHaveTextContent('Korrespondenz')
    expect(within(lines[1]).getByText('new')).toBeInTheDocument()
    expect(lines[1]).toHaveTextContent('1 file')
    expect(within(lines[1]).getByRole('button', { name: 'Create and move' })).toBeInTheDocument()
  })

  it('shows for a single file where it is asked to (the upload tray)', () => {
    renderView([ONE_EACH], { minFiles: 1 })
    expect(screen.getByTestId('filing-bar')).toBeInTheDocument()
  })

  it('outlines exactly the cards a line would move while it is hovered, and none after', async () => {
    const user = userEvent.setup()
    renderView([PERMIT_DECISIONS, BRIEF])
    const [permitDecisions, brief] = screen.getAllByTestId('filing-bar-line')
    expect(litCards()).toEqual([])

    await user.hover(permitDecisions)
    expect(litCards()).toEqual(['doc_ma37', 'doc_ma22'])
    expect(permitDecisions).toHaveAttribute('data-active')

    await user.hover(brief)
    expect(litCards()).toEqual(['doc_brief'])

    await user.unhover(brief)
    expect(litCards()).toEqual([])
  })

  it('outlines them while focus is in the line, for a keyboard', async () => {
    const user = userEvent.setup()
    renderView([PERMIT_DECISIONS, BRIEF])
    const [permitDecisions] = screen.getAllByTestId('filing-bar-line')
    within(permitDecisions).getByRole('button', { name: 'Leave it' }).focus()
    await waitFor(() => expect(litCards()).toEqual(['doc_ma37', 'doc_ma22']))
    await user.tab({ shift: true })
    await waitFor(() => expect(litCards()).toEqual([]))
  })

  it('outlines the rows of the list the same way, and no others', async () => {
    const user = userEvent.setup()
    renderView([PERMIT_DECISIONS, BRIEF], { view: 'list' })
    await user.hover(screen.getAllByTestId('filing-bar-line')[0])
    const lit = screen
      .getAllByTestId('file-list-row')
      .filter((row) => row.className.includes('outline-strong'))
      .map((row) => row.textContent)
    expect(lit).toHaveLength(2)
    expect(lit.join(' ')).toContain('MA37.pdf')
    expect(lit.join(' ')).toContain('MA22.pdf')
  })

  it('moves a folder’s files through its proposal and tells the shelf to re-read', async () => {
    const user = userEvent.setup()
    const onSettled = renderView([PERMIT_DECISIONS, BRIEF])
    const [permitDecisions] = screen.getAllByTestId('filing-bar-line')
    await user.click(await within(permitDecisions).findByRole('button', { name: 'Move' }))
    expect(await within(permitDecisions).findByText('Moved to “Behörde/Bescheide”.')).toBeInTheDocument()
    await waitFor(() => expect(onSettled).toHaveBeenCalled())
  })

  it('shows a reader who may not decide no buttons', async () => {
    const readOnly = [PERMIT_DECISIONS, BRIEF].map((entry) => ({ ...entry, proposal: { ...entry.proposal, canDecide: false } }))
    for (const { proposal } of readOnly) store.set(proposal.id, proposal as FileProposal)
    renderView(readOnly)
    const bar = screen.getByTestId('filing-bar')
    expect(await within(bar).findAllByText('Only people who may file here can move it.')).toHaveLength(2)
    expect(within(bar).queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('filingBarEntries', () => {
  const byFolder = suggestionsByFolder([PERMIT_DECISIONS, BRIEF])

  it('keeps the folders whose files are in view, when one of them collects enough', () => {
    expect(filingBarEntries(byFolder, IDS, 2).map((entry) => entry.suggestion.folder)).toEqual([
      'Behörde/Bescheide',
      'Korrespondenz',
    ])
    expect(filingBarEntries(byFolder, ['doc_brief'], 2)).toEqual([])
    expect(filingBarEntries(byFolder, ['doc_brief'], 1).map((entry) => entry.suggestion.folder)).toEqual(['Korrespondenz'])
    expect(filingBarEntries(byFolder, ['doc_elsewhere'], 1)).toEqual([])
  })
})

describe('InlineSuggestion', () => {
  it('is gone, and nothing calls it', () => {
    expect(() => statSync(join(__dirname, '..', '..', '..', 'components', 'ui', 'inline-suggestion.tsx'))).toThrow()
    const src = join(__dirname, '..', '..', '..')
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
      })
    const callers = walk(src).filter(
      // Specs may name it to assert it is absent; code may not.
      (path) => !/\.spec\.tsx?$/.test(path) && /InlineSuggestion|inline-suggestion/.test(readFileSync(path, 'utf8'))
    )
    expect(callers).toEqual([])
  })
})
