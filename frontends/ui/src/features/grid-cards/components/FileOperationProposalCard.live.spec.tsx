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
 * 5. **A colleague's decision shows without a reload.** While the proposal is
 *    open the card listens on `proposal:<id>` (ADR-0104); a hint, or the
 *    channel coming up, re-reads the object. A decided card listens to nothing.
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
import {
  CHANNEL,
  decidedByAnna,
  FakeEventSource,
  gets,
  hint,
  openStream,
  PROPOSAL_ID,
  proposalBase,
  requests,
  resetKit,
  serve,
  startRecording,
  useFakeStream,
} from './proposal-test-kit'

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

const OPERATIONS = [
  { document: 'Grundriss EG.pdf', source: 'projekt' as const, current: 'Nachweise', target_folder: 'Einreichung' },
  { document: 'Grundriss OG.pdf', source: 'projekt' as const, current: '', target_folder: 'Einreichung' },
]

type FileProposal = Extract<ProposedChangeView, { kind: 'file_operation' }>

const proposal = (patch: Partial<FileProposal> = {}): FileProposal => ({
  ...proposalBase(),
  kind: 'file_operation',
  payload: { operation: 'move', operations: OPERATIONS, note: null },
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

beforeEach(() => {
  startRecording()
  vi.clearAllMocks()
})

afterEach(resetKit)

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
    expect(screen.getByTestId('proposal-decided-by')).toHaveTextContent(/^Applied by Anna Berger · /)
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
    expect(screen.getByTestId('proposal-decided-by')).toHaveTextContent(/^Discarded by Anna Berger · /)
  })

  it('hides the buttons and says why when the server says this reader may not decide', async () => {
    serve(proposal({ canDecide: false }))
    render(card)

    expect(await screen.findByTestId('proposal-unavailable')).toHaveTextContent('not apply it')
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
    expect(screen.getByTestId('proposal-decided-by')).toHaveTextContent(/^Applied by Mia Huber · /)
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

  it('keeps focus on the pressed button while it works and ignores a second press', async () => {
    serve(proposal())
    server.use(
      http.post(`/api/proposals/${PROPOSAL_ID}/apply`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return HttpResponse.json({
          proposal: proposal(decidedByAnna('applied', [{ label: 'a', ok: true }, { label: 'b', ok: true }])),
        })
      })
    )
    const user = userEvent.setup()
    render(card)

    const apply = await screen.findByRole('button', { name: 'Apply' })
    apply.focus()
    await user.keyboard('{Enter}')
    const busy = screen.getByRole('button', { name: /^Applying/ })
    expect(busy).toBe(apply)
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveFocus()
    await user.keyboard('{Enter}')
    await screen.findByText('2 files moved.')
    expect(requests.filter((line) => line.startsWith('POST'))).toHaveLength(1)
  })

  it("shows the colleague's decision when the server answers 409", async () => {
    let reads = 0
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

    expect(await screen.findByTestId('proposal-decided-by')).toHaveTextContent(/^Applied by Anna Berger · /)
    expect(screen.getByTestId('proposal-overtaken')).toBeInTheDocument()
    expect(screen.queryByText('Could not be applied.')).toBeNull()
    expect(gets()).toHaveLength(2)
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

describe('FileOperationProposalCard with a proposal_id — live', () => {
  it("shows a colleague's apply when the channel says so, without a click or a reload", async () => {
    useFakeStream()
    const served = serve(proposal())
    const changed = vi.fn()
    const unsubscribe = onDocumentsChanged(changed)
    render(card)

    expect(await screen.findByRole('button', { name: 'Apply' })).toBeInTheDocument()
    const stream = await openStream()
    expect(stream.url).toContain(`ch=${encodeURIComponent(CHANNEL)}`)
    // The channel coming up reads once more: a decision between the first read and the subscription.
    await waitFor(() => expect(gets()).toHaveLength(2))
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()

    served.current = proposal(
      decidedByAnna('applied', [
        { label: 'Grundriss EG.pdf', ok: true },
        { label: 'Grundriss OG.pdf', ok: true },
      ])
    )
    stream.say(hint('applied'))

    expect(await screen.findByText('2 files moved.')).toBeInTheDocument()
    expect(screen.getByTestId('proposal-decided-by')).toHaveTextContent(/^Applied by Anna Berger · /)
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    expect(screen.queryByTestId('proposal-overtaken')).toBeNull()
    expect(gets()).toHaveLength(3)
    // A colleague's apply changed files too: the Files list is told, once.
    expect(changed).toHaveBeenCalledTimes(1)
    expect(requests.some((line) => line.startsWith('POST'))).toBe(false)
    unsubscribe()
  })

  it("shows a colleague's discard the same way", async () => {
    useFakeStream()
    const served = serve(proposal())
    render(card)

    await screen.findByRole('button', { name: 'Discard' })
    const stream = await openStream()
    await waitFor(() => expect(requests).toHaveLength(2))
    served.current = proposal(decidedByAnna('dismissed'))
    stream.say(hint('dismissed'))

    expect(await screen.findByText('Discarded. Nothing was changed.')).toBeInTheDocument()
    expect(screen.getByTestId('proposal-decided-by')).toHaveTextContent(/^Discarded by Anna Berger · /)
  })

  it('reads again when the stream comes back, because a decision may have fallen in the gap', async () => {
    useFakeStream()
    const served = serve(proposal())
    render(card)

    await screen.findByRole('button', { name: 'Apply' })
    const stream = await openStream()
    await waitFor(() => expect(requests).toHaveLength(2))
    stream.onerror?.(new Event('error'))
    served.current = proposal(decidedByAnna('dismissed'))
    // The ladder reopens the stream; a new source announces itself live.
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2), { timeout: 4000 })
    FakeEventSource.instances[1].open()

    expect(await screen.findByText('Discarded. Nothing was changed.')).toBeInTheDocument()
  })

  it('ignores a hint about another proposal, and one that is not a decision', async () => {
    useFakeStream()
    serve(proposal())
    render(card)

    await screen.findByRole('button', { name: 'Apply' })
    const stream = await openStream()
    await waitFor(() => expect(requests).toHaveLength(2))
    stream.say(hint('applied', '00000000-0000-4000-8000-0000000000b2'))
    stream.say(hint('proposed'))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(requests).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
  })

  it('does not listen once the proposal is decided', async () => {
    useFakeStream()
    serve(proposal(decidedByAnna('applied', [{ label: 'Grundriss EG.pdf', ok: true }])))
    render(card)

    expect(await screen.findByTestId('proposal-decided-by')).toBeInTheDocument()
    // Longer than the connection's debounce: a channel that was wanted would have opened by now.
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(FakeEventSource.instances).toHaveLength(0)
    expect(requests).toEqual([`GET /api/proposals/${PROPOSAL_ID}`])
  })

  it('stays as it was when the re-read fails', async () => {
    useFakeStream()
    serve(proposal())
    render(card)

    await screen.findByRole('button', { name: 'Apply' })
    const stream = await openStream()
    await waitFor(() => expect(requests).toHaveLength(2))
    server.use(http.get(`/api/proposals/${PROPOSAL_ID}`, () => HttpResponse.json({ error: 'boom' }, { status: 500 })))
    stream.say(hint('applied'))
    await waitFor(() => expect(requests).toHaveLength(3))

    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(screen.queryByTestId('proposal-unavailable')).toBeNull()
  })
})
