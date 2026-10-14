import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test-utils'
import { server } from '@/mocks/server'
import {
  PROPOSAL_ID,
  proposalBase,
  resetKit,
  useFakeStream,
} from '@/features/grid-cards/components/proposal-test-kit'
import type { ProposedChangeView } from '@/lib/proposals/types'
import { FilingSuggestionsProvider, FilingSuggestionSlot } from './filing-suggestion'
import { suggestionsByDocument, type FilingSuggestionView } from '../lib/filing-suggestions'

type FileProposal = Extract<ProposedChangeView, { kind: 'file_operation' }>

const proposal = (patch: Partial<FileProposal> = {}): FileProposal => ({
  ...proposalBase({ originConversationId: null, originMessageId: null }),
  kind: 'file_operation',
  payload: {
    operation: 'move',
    operations: [
      { document: 'MA37_Bescheid.pdf', source: 'projekt', target_folder: 'Bescheide', reason: 'Ein Bescheid der MA 37.' },
      { document: 'Stellungnahme.pdf', source: 'projekt', target_folder: 'Bescheide', reason: 'Eine Stellungnahme.' },
    ],
    basis: 'name',
  },
  ...patch,
})

const DOCUMENTS = [
  { id: 'doc_1', name: 'MA37_Bescheid.pdf' },
  { id: 'doc_2', name: 'Stellungnahme.pdf' },
]

function renderSlot(listed: FileProposal, documentId = 'doc_1', onSettled = vi.fn()) {
  const byDocument = suggestionsByDocument([{ proposal: listed, documents: DOCUMENTS }])
  render(
    <FilingSuggestionsProvider byDocument={byDocument} onSettled={onSettled}>
      <FilingSuggestionSlot documentId={documentId} />
    </FilingSuggestionsProvider>
  )
  return onSettled
}

let current: FileProposal

beforeEach(() => {
  useFakeStream()
  current = proposal()
  server.use(
    http.get(`/api/proposals/${PROPOSAL_ID}`, () => HttpResponse.json({ proposal: current })),
    http.post(`/api/proposals/${PROPOSAL_ID}/apply`, () => {
      current = proposal({
        status: 'applied',
        decidedBy: 'user_me',
        decidedAt: '2026-10-13T09:00:00.000Z',
        canDecide: false,
        results: [
          { label: 'MA37_Bescheid.pdf', ok: true },
          { label: 'Stellungnahme.pdf', ok: true },
        ],
      })
      return HttpResponse.json({ proposal: current })
    }),
    http.post(`/api/proposals/${PROPOSAL_ID}/dismiss`, () => {
      current = proposal({ status: 'dismissed', decidedBy: 'user_me', decidedAt: '2026-10-13T09:00:00.000Z', canDecide: false })
      return HttpResponse.json({ proposal: current })
    })
  )
})

afterEach(() => {
  resetKit()
})

describe('FilingSuggestion', () => {
  it('says where the file belongs, why, and that the one click moves the folder’s other file too', async () => {
    renderSlot(current)
    expect(await screen.findByText('Belongs in “Bescheide”')).toBeInTheDocument()
    expect(screen.getByText('Ein Bescheid der MA 37. · with 1 more file')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move all 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Leave it' })).toBeInTheDocument()
  })

  it('moves it with one click, through the proposal, and tells the shelf to re-read', async () => {
    const onSettled = renderSlot(current)
    await userEvent.click(await screen.findByRole('button', { name: 'Move all 2' }))
    expect(await screen.findByText('Moved to “Bescheide”.')).toBeInTheDocument()
    await waitFor(() => expect(onSettled).toHaveBeenCalled())
  })

  it('leaves it with the other click, as a dismissal of the proposal', async () => {
    const onSettled = renderSlot(current)
    await userEvent.click(await screen.findByRole('button', { name: 'Leave it' }))
    expect(await screen.findByText('Stays where it is.')).toBeInTheDocument()
    await waitFor(() => expect(onSettled).toHaveBeenCalled())
  })

  it('offers to create a folder that does not exist yet, in the same one click', async () => {
    current = proposal({
      payload: {
        operation: 'move',
        operations: [{ document: 'MA37_Bescheid.pdf', source: 'projekt', target_folder: 'Korrespondenz', reason: 'Ein Brief.' }],
        basis: 'name',
        new_folder: { path: 'Korrespondenz', description: 'Briefe und Mails' },
      },
    })
    renderSlot(current)
    expect(await screen.findByText('Belongs in a new folder “Korrespondenz”')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create and move' })).toBeInTheDocument()
  })

  it('shows a reader who may not move it the suggestion and no buttons', async () => {
    current = proposal({ canDecide: false })
    renderSlot(current)
    expect(await screen.findByText('Only people who may file here can move it.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('draws nothing for a file Piloti has nothing to say about', () => {
    renderSlot(current, 'doc_elsewhere')
    expect(screen.queryByTestId('filing-suggestion')).not.toBeInTheDocument()
  })
})

describe('suggestionsByDocument', () => {
  const view = (byDocument: Map<string, FilingSuggestionView>, id: string) => byDocument.get(id)

  it('keys each file of a filing suggestion by its document, with its own reason', () => {
    const byDocument = suggestionsByDocument([{ proposal: proposal(), documents: DOCUMENTS }])
    expect(view(byDocument, 'doc_2')).toEqual({
      proposalId: PROPOSAL_ID,
      folder: 'Bescheide',
      reason: 'Eine Stellungnahme.',
      isNew: false,
      basis: 'name',
      fileCount: 2,
      canDecide: true,
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
