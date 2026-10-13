/**
 * The `file_operation_proposal` card when it carries a `proposal_id`: a
 * receipt of a proposed change the server holds (ADR-0105).
 *
 * What this file holds the card to:
 *
 * 1. **The object is the truth.** The card reads the proposal when it is shown
 *    and draws its status, its result per row and who decided it.
 * 2. **Accept asks the server.** It POSTs `/api/proposals/[id]/apply` and runs
 *    nothing in the browser: no document, folder or assignment route.
 * 3. **A colleague who was faster wins.** A 409 re-reads the proposal and
 *    shows their decision instead of an error.
 * 4. **Nothing lands in `cardInteractions`.** A decision recorded on the
 *    message would be a second truth beside the object.
 *
 * Rendered without an `I18nProvider`, so the dictionary falls back to `en`.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/mocks/server'
import { onDocumentsChanged } from '@/lib/documents/document-changes'
import type { ProposedChangeView } from '@/lib/proposals/types'
import { FileOperationProposalCard } from './FileOperationProposalCard'

const setCardDecision = vi.fn()

const mockStoreState = () => ({
  projectId: 'proj-1',
  currentConversation: { id: 'conv-1', messages: [{ id: 'msg-1', cardInteractions: undefined }] },
  conversations: [],
  setCardDecision,
})

vi.mock('@/features/chat/store', () => {
  const useChatStore = (selector: (s: ReturnType<typeof mockStoreState>) => unknown) => selector(mockStoreState())
  useChatStore.getState = () => mockStoreState()
  return { useChatStore }
})

const PROPOSAL_ID = '00000000-0000-4000-8000-0000000000a1'

const OPERATIONS = [
  { document: 'Grundriss EG.pdf', source: 'projekt' as const, current: 'Nachweise', target_folder: 'Einreichung' },
  { document: 'Grundriss OG.pdf', source: 'projekt' as const, current: '', target_folder: 'Einreichung' },
]

const proposal = (patch: Partial<ProposedChangeView> = {}): ProposedChangeView => ({
  id: PROPOSAL_ID,
  projectId: 'proj-1',
  kind: 'file_operation',
  payload: { operation: 'move', operations: OPERATIONS, note: null },
  status: 'proposed',
  proposedByKind: 'piloti',
  onBehalfOf: 'user_me',
  onBehalfOfName: 'Mia Huber',
  originConversationId: 'conv-1',
  originMessageId: 'msg-1',
  createdAt: '2026-10-13T08:00:00.000Z',
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  results: null,
  canDecide: true,
  ...patch,
})

const card = (
  <FileOperationProposalCard
    title="Move two files"
    operation="move"
    operations={OPERATIONS}
    proposalId={PROPOSAL_ID}
    messageId="msg-1"
    cardKey="file_operation_proposal-0"
  />
)

/** Every request the card made, as `METHOD path`. */
let requests: string[] = []
const record = ({ request }: { request: Request }) => {
  requests.push(`${request.method} ${new URL(request.url).pathname}`)
}

const serve = (initial: ProposedChangeView) => {
  server.events.on('request:start', record)
  server.use(http.get(`/api/proposals/${PROPOSAL_ID}`, () => HttpResponse.json({ proposal: initial })))
}

beforeEach(() => {
  requests = []
  vi.clearAllMocks()
})

afterEach(() => {
  server.events.removeAllListeners()
})

describe('FileOperationProposalCard with a proposal_id — what it shows', () => {
  it('reads the proposal and offers the decision the server allows', async () => {
    serve(proposal())
    render(card)

    expect(screen.getByText('Grundriss EG.pdf')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(requests).toEqual([`GET /api/proposals/${PROPOSAL_ID}`])
  })

  it('renders a partially applied proposal with its result per row and who applied it', async () => {
    serve(
      proposal({
        status: 'partially_applied',
        decidedBy: 'user_anna',
        decidedByName: 'Anna Berger',
        decidedAt: '2026-10-13T09:30:00.000Z',
        results: [
          { label: 'Grundriss EG.pdf', ok: true },
          { label: 'Grundriss OG.pdf', ok: false, reason: '„Grundriss OG.pdf“ wurde nicht gefunden' },
        ],
        canDecide: false,
      })
    )
    render(card)

    expect(await screen.findByText('1 of 2 applied.')).toBeInTheDocument()
    expect(screen.getAllByTestId('file-operation-row-ok')).toHaveLength(1)
    expect(screen.getByTestId('file-operation-row-error')).toHaveTextContent('wurde nicht gefunden')
    expect(screen.getByTestId('file-operation-decided-by')).toHaveTextContent(/^Applied by Anna Berger · /)
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })

  it('renders a dismissed proposal with who discarded it', async () => {
    serve(
      proposal({
        status: 'dismissed',
        decidedBy: 'user_anna',
        decidedByName: 'Anna Berger',
        decidedAt: '2026-10-13T09:30:00.000Z',
        canDecide: false,
      })
    )
    render(card)

    expect(await screen.findByText('Discarded. Nothing was changed.')).toBeInTheDocument()
    expect(screen.getByTestId('file-operation-decided-by')).toHaveTextContent(/^Discarded by Anna Berger · /)
  })

  it('hides the buttons and says why when the server says this reader may not decide', async () => {
    serve(proposal({ canDecide: false }))
    render(card)

    expect(await screen.findByTestId('file-operation-unavailable')).toHaveTextContent('not apply it')
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
  })
})

describe('FileOperationProposalCard with a proposal_id — deciding', () => {
  it('Accept POSTs apply, runs nothing in the browser and shows the results', async () => {
    serve(proposal())
    server.use(
      http.post(`/api/proposals/${PROPOSAL_ID}/apply`, () =>
        HttpResponse.json({
          proposal: proposal({
            status: 'applied',
            decidedBy: 'user_me',
            decidedByName: 'Mia Huber',
            decidedAt: '2026-10-13T09:30:00.000Z',
            results: [
              { label: 'Grundriss EG.pdf', ok: true },
              { label: 'Grundriss OG.pdf', ok: true },
            ],
            canDecide: false,
          }),
        })
      )
    )
    const changed = vi.fn()
    const unsubscribe = onDocumentsChanged(changed)
    const user = userEvent.setup()
    render(card)

    await user.click(await screen.findByRole('button', { name: 'Apply' }))

    expect(await screen.findByText('2 files moved.')).toBeInTheDocument()
    expect(screen.getAllByTestId('file-operation-row-ok')).toHaveLength(2)
    expect(screen.getByTestId('file-operation-decided-by')).toHaveTextContent(/^Applied by Mia Huber · /)
    expect(requests).toEqual([`GET /api/proposals/${PROPOSAL_ID}`, `POST /api/proposals/${PROPOSAL_ID}/apply`])
    // The Files list is told, as it is after a browser-side apply.
    expect(changed).toHaveBeenCalledTimes(1)
    // The object is the truth: nothing is recorded on the message.
    expect(setCardDecision).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('Discard POSTs dismiss and records nothing on the message', async () => {
    serve(proposal())
    server.use(
      http.post(`/api/proposals/${PROPOSAL_ID}/dismiss`, () =>
        HttpResponse.json({
          proposal: proposal({
            status: 'dismissed',
            decidedBy: 'user_me',
            decidedByName: 'Mia Huber',
            decidedAt: '2026-10-13T09:30:00.000Z',
            canDecide: false,
          }),
        })
      )
    )
    const user = userEvent.setup()
    render(card)

    await user.click(await screen.findByRole('button', { name: 'Discard' }))

    expect(await screen.findByText('Discarded. Nothing was changed.')).toBeInTheDocument()
    expect(requests).toContain(`POST /api/proposals/${PROPOSAL_ID}/dismiss`)
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it("shows the colleague's decision when the server answers 409", async () => {
    let reads = 0
    server.events.on('request:start', record)
    server.use(
      http.get(`/api/proposals/${PROPOSAL_ID}`, () => {
        reads += 1
        return HttpResponse.json({
          proposal:
            reads === 1
              ? proposal()
              : proposal({
                  status: 'applied',
                  decidedBy: 'user_anna',
                  decidedByName: 'Anna Berger',
                  decidedAt: '2026-10-13T09:29:00.000Z',
                  results: [
                    { label: 'Grundriss EG.pdf', ok: true },
                    { label: 'Grundriss OG.pdf', ok: true },
                  ],
                  canDecide: false,
                }),
        })
      }),
      http.post(`/api/proposals/${PROPOSAL_ID}/apply`, () =>
        HttpResponse.json({ error: 'Already decided', code: 'PROPOSAL_DECIDED' }, { status: 409 })
      )
    )
    const user = userEvent.setup()
    render(card)

    await user.click(await screen.findByRole('button', { name: 'Apply' }))

    expect(await screen.findByTestId('file-operation-decided-by')).toHaveTextContent(/^Applied by Anna Berger · /)
    expect(screen.getByTestId('file-operation-overtaken')).toBeInTheDocument()
    expect(screen.queryByText('Could not be applied.')).toBeNull()
    expect(requests.filter((line) => line.startsWith('GET'))).toHaveLength(2)
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('keeps the question open and says so when apply fails for another reason', async () => {
    serve(proposal())
    server.use(
      http.post(`/api/proposals/${PROPOSAL_ID}/apply`, () => HttpResponse.json({ error: 'boom' }, { status: 500 }))
    )
    const user = userEvent.setup()
    render(card)

    await user.click(await screen.findByRole('button', { name: 'Apply' }))

    expect(await screen.findByText('Could not be applied.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).not.toHaveAttribute('aria-disabled'))
    expect(setCardDecision).not.toHaveBeenCalled()
  })
})
