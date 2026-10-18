/**
 * The memory and project-profile cards WITH a `proposal_id`: receipts of a
 * proposed change the server holds (ADR-0105), drawn by the same frame as the
 * file-operation card (whose own spec is `FileOperationProposalCard.live.spec.tsx`).
 *
 * What this file holds them to, per kind:
 *
 * 1. **The object is the truth.** The card reads the proposal and draws what is
 *    stored, its status, who decided it and when.
 * 2. **A decision is a write to the proposal.** Übernehmen POSTs `…/apply`,
 *    Verwerfen POSTs `…/dismiss`, and nothing is recorded on the message
 *    (`cardInteractions`): a second truth beside the object.
 * 3. **`canDecide` is the server's word.** Without it there is nothing to press.
 * 4. **A colleague's decision shows without a reload**, over `proposal:<id>`.
 * 5. Per kind: a memory note offers „Nur im Projekt merken“ and sends the
 *    body for it; a profile change draws before → after from its PATCH against
 *    the profile as it is, never from a model's preview.
 *
 * Rendered without an `I18nProvider`, so the dictionary falls back to `en`.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/mocks/server'
import type { ProjectProfile, ProjectProfilePatchOperation } from '@/lib/project-profile/types'
import type { ProposedChangeView } from '@/lib/proposals/types'
import type { GridCard } from '@/shared/cards/schemas'
import { resetDecidedProposals, useDecidedProposals } from '../decided-proposals'
import { GridCards } from './GridCards'
import { MemoryProposalCard } from './MemoryProposalCard'
import { ProjectProfilePatchCard } from './ProjectProfilePatchCard'
import {
  decidedByAnna,
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
const invalidateProjectFacts = vi.fn()

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

vi.mock('@/features/chat/hooks/use-project-facts', () => ({
  invalidateProjectFacts: (projectId: string) => invalidateProjectFacts(projectId),
  useProjectFacts: () => null,
}))

type MemoryProposal = Extract<ProposedChangeView, { kind: 'memory' }>
type ProfileProposal = Extract<ProposedChangeView, { kind: 'project_profile' }>

const NOTE = 'Das Büro setzt bei GK 4 durchgängig REI 90 an.'

const memoryProposal = (patch: Partial<MemoryProposal> = {}): MemoryProposal => ({
  ...proposalBase(),
  kind: 'memory',
  payload: { scope: 'organization', kind: 'preference', content: NOTE, confidence: 'high', supersedes: null },
  ...patch,
})

const memoryCard = (
  <MemoryProposalCard
    title="Remember this?"
    content={NOTE}
    kind="preference"
    confidence="high"
    proposalId={PROPOSAL_ID}
    messageId="msg-1"
    cardKey="memory_proposal-0"
  />
)

const PATCH: ProjectProfilePatchOperation[] = [{ op: 'add', path: '/facts/waermeversorgung', value: 'waermepumpe' }]

const profileProposal = (patch: Partial<ProfileProposal> = {}): ProfileProposal => ({
  ...proposalBase(),
  kind: 'project_profile',
  payload: { title: 'Wärmeversorgung festhalten', rationale: 'Sie haben eine Wärmepumpe genannt.', patch: PATCH },
  ...patch,
})

// The stored profile holds a value that differs from the patch, so „before“
// can only come from the profile and „after“ only from the patch.
const storedProfile: ProjectProfile = {
  facts: {
    waermeversorgung: {
      value: 'gas',
      confidence: 'confirmed',
      source: 'onboarding',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  },
  goals: {},
  unknowns: [],
  assumptions: {},
}

const profileCard = (
  <ProjectProfilePatchCard
    title="Update brief"
    rationale="Learned the class."
    patch={[{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK4' }]}
    projectId="proj-1"
    proposalId={PROPOSAL_ID}
    messageId="msg-1"
    cardKey="project_profile_patch-0"
  />
)

beforeEach(() => {
  startRecording()
  vi.clearAllMocks()
  server.use(http.get('/api/projects/proj-1/profile', () => HttpResponse.json({ profile: storedProfile, profileVersion: 1 })))
})

afterEach(() => {
  resetKit()
  resetDecidedProposals()
})

const posts = () => requests.filter((line) => line.startsWith('POST'))

describe('memory proposal with a proposal_id', () => {
  it('draws the stored note: its kind, confidence and where it goes, and offers the decision', async () => {
    serve(memoryProposal())
    render(memoryCard)

    expect(screen.getByText(NOTE)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(screen.getByText('Confidence: high')).toBeInTheDocument()
    expect(screen.getByTestId('memory-destination')).toHaveTextContent("office's memory")
    expect(screen.queryByTestId('memory-supersedes')).toBeNull()
    // Nothing is written by being looked at.
    expect(requests).toEqual([`GET /api/proposals/${PROPOSAL_ID}`])
  })

  it('says which note a correction replaces', async () => {
    serve(
      memoryProposal({
        payload: {
          scope: 'organization',
          kind: 'preference',
          content: NOTE,
          confidence: 'high',
          supersedes: 'Das Büro setzt bei GK 4 REI 60 an.',
        },
      })
    )
    render(memoryCard)

    expect(await screen.findByTestId('memory-supersedes')).toHaveTextContent(
      'Replaces: “Das Büro setzt bei GK 4 REI 60 an.”'
    )
  })

  it('Apply POSTs apply without a body, shows who remembered it, and records nothing on the message', async () => {
    serve(memoryProposal())
    let body = 'unset'
    server.use(
      http.post(`/api/proposals/${PROPOSAL_ID}/apply`, async ({ request }) => {
        body = await request.text()
        return HttpResponse.json({
          proposal: memoryProposal({
            ...decidedByAnna('applied', [{ label: NOTE, ok: true, itemId: 'm-1', scope: 'organization' }]),
            decidedBy: 'user_me',
            decidedByName: 'Mia Huber',
          }),
        })
      })
    )
    const user = userEvent.setup()
    render(memoryCard)

    await user.click(await screen.findByRole('button', { name: 'Apply' }))

    expect(await screen.findByText("Remembered in the office's memory.")).toBeInTheDocument()
    expect(screen.getByTestId('proposal-decided-by')).toHaveTextContent(/^Applied by Mia Huber · /)
    expect(body).toBe('')
    expect(posts()).toEqual([`POST /api/proposals/${PROPOSAL_ID}/apply`])
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('„Remember in the project only“ applies with { memoryScope: "project" }', async () => {
    serve(memoryProposal())
    let body: unknown
    server.use(
      http.post(`/api/proposals/${PROPOSAL_ID}/apply`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({
          proposal: memoryProposal(decidedByAnna('applied', [{ label: NOTE, ok: true, itemId: 'm-1', scope: 'project' }])),
        })
      })
    )
    const user = userEvent.setup()
    render(memoryCard)

    await user.click(await screen.findByRole('button', { name: 'Remember in the project only' }))

    expect(await screen.findByText('Remembered in the project.')).toBeInTheDocument()
    expect(body).toEqual({ memoryScope: 'project' })
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('lists „Apply“ before the project-only way in and before „Discard“, full width on a phone', async () => {
    serve(memoryProposal())
    render(memoryCard)

    const apply = await screen.findByRole('button', { name: 'Apply' })
    const project = screen.getByRole('button', { name: 'Remember in the project only' })
    const discard = screen.getByRole('button', { name: 'Discard' })
    const follows = (a: HTMLElement, b: HTMLElement) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(apply, project)).toBe(true)
    expect(follows(project, discard)).toBe(true)
    for (const button of [apply, project, discard]) {
      expect(button).toHaveClass('max-sm:w-full', 'max-sm:h-11')
    }
  })

  it('offers no project-only action for a note that is already the project’s', async () => {
    serve(
      memoryProposal({
        payload: { scope: 'project', kind: 'decision', content: NOTE, confidence: 'medium', supersedes: null },
      })
    )
    render(memoryCard)

    expect(await screen.findByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(screen.getByTestId('memory-destination')).toHaveTextContent("this project's memory")
    expect(screen.queryByRole('button', { name: 'Remember in the project only' })).toBeNull()
  })

  it('Discard POSTs dismiss and says nothing was remembered', async () => {
    serve(memoryProposal())
    server.use(
      http.post(`/api/proposals/${PROPOSAL_ID}/dismiss`, () =>
        HttpResponse.json({ proposal: memoryProposal(decidedByAnna('dismissed')) })
      )
    )
    const user = userEvent.setup()
    render(memoryCard)

    await user.click(await screen.findByRole('button', { name: 'Discard' }))

    expect(await screen.findByText('Discarded. Nothing was remembered.')).toBeInTheDocument()
    expect(screen.getByTestId('proposal-decided-by')).toHaveTextContent(/^Discarded by Anna Berger · /)
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('hides every action and says why when the server says this reader may not decide', async () => {
    serve(memoryProposal({ canDecide: false }))
    render(memoryCard)

    expect(await screen.findByTestId('proposal-unavailable')).toHaveTextContent('not apply it')
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remember in the project only' })).toBeNull()
  })

  it('shows what a refusal said when nothing could be remembered', async () => {
    serve(
      memoryProposal(
        decidedByAnna('failed', [{ label: NOTE, ok: false, reason: 'Diese Unterhaltung stützt sich auf einen Ordner' }])
      )
    )
    render(memoryCard)

    expect(await screen.findByText('Nothing could be applied. Nothing was changed.')).toBeInTheDocument()
    expect(screen.getByTestId('proposal-failures')).toHaveTextContent('stützt sich auf einen Ordner')
  })

  it('says „Note remembered.“ for a row decided before the scope was recorded', async () => {
    serve(memoryProposal(decidedByAnna('applied', [{ label: NOTE, ok: true, itemId: 'm-1' }])))
    render(memoryCard)

    expect(await screen.findByText('Note remembered.')).toBeInTheDocument()
  })

  it('tells the tab how the proposal ended, for the chip, and never the message', async () => {
    const served = serve(memoryProposal())
    render(memoryCard)
    await screen.findByRole('button', { name: 'Apply' })
    // Open: nothing to tell.
    expect(useDecidedProposals.getState().byId).toEqual({})

    server.use(
      http.post(`/api/proposals/${PROPOSAL_ID}/apply`, () =>
        HttpResponse.json({
          proposal: memoryProposal(decidedByAnna('applied', [{ label: NOTE, ok: true, itemId: 'm-1', scope: 'organization' }])),
        })
      )
    )
    served.current = memoryProposal()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Apply' }))

    await screen.findByTestId('proposal-status')
    expect(useDecidedProposals.getState().byId[PROPOSAL_ID]).toMatchObject({ status: 'applied' })
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('tells the tab of a proposal that was already decided when the card was shown', async () => {
    serve(memoryProposal(decidedByAnna('dismissed')))
    render(memoryCard)

    await screen.findByTestId('proposal-status')
    expect(useDecidedProposals.getState().byId[PROPOSAL_ID]).toMatchObject({ status: 'dismissed' })
  })

  it("shows a colleague's decision when the channel says so, without a click or a reload", async () => {
    useFakeStream()
    const served = serve(memoryProposal())
    render(memoryCard)

    await screen.findByRole('button', { name: 'Apply' })
    const stream = await openStream()
    await waitFor(() => expect(gets()).toHaveLength(2))
    served.current = memoryProposal(decidedByAnna('applied', [{ label: NOTE, ok: true, itemId: 'm-1' }]))
    stream.say(hint('applied'))

    expect(await screen.findByText('Note remembered.')).toBeInTheDocument()
    expect(screen.getByTestId('proposal-decided-by')).toHaveTextContent(/^Applied by Anna Berger · /)
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    expect(posts()).toEqual([])
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('shows the colleague’s decision instead of an error when the click comes second (409)', async () => {
    let reads = 0
    server.use(
      http.get(`/api/proposals/${PROPOSAL_ID}`, () => {
        reads += 1
        return HttpResponse.json({
          proposal:
            reads === 1
              ? memoryProposal()
              : memoryProposal(decidedByAnna('dismissed')),
        })
      }),
      http.post(`/api/proposals/${PROPOSAL_ID}/apply`, () =>
        HttpResponse.json({ error: 'Already decided', code: 'PROPOSAL_DECIDED' }, { status: 409 })
      )
    )
    const user = userEvent.setup()
    render(memoryCard)

    await user.click(await screen.findByRole('button', { name: 'Apply' }))

    expect(await screen.findByTestId('proposal-decided-by')).toHaveTextContent(/^Discarded by Anna Berger · /)
    expect(screen.getByTestId('proposal-overtaken')).toBeInTheDocument()
    expect(screen.queryByText('Could not be applied.')).toBeNull()
  })
})

describe('project profile proposal with a proposal_id', () => {
  it('draws before → after from the stored PATCH and the profile as it is, and offers the decision', async () => {
    serve(profileProposal())
    render(profileCard)

    // The stored change wins over the card's own copy once it has been read.
    expect(await screen.findByText('Wärmeversorgung festhalten')).toBeInTheDocument()
    expect(screen.getByText('Sie haben eine Wärmepumpe genannt.')).toBeInTheDocument()
    expect(await screen.findByText('Geplante Wärmeversorgung')).toBeInTheDocument()
    expect(screen.getByText('Wärmepumpe')).toBeInTheDocument()
    expect(await screen.findByText('Gas (nur Bestand)')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Before' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Apply' })).toBeInTheDocument()
  })

  it('Apply POSTs apply, shows the change as made without a „before“, and records nothing on the message', async () => {
    serve(profileProposal())
    server.use(
      http.post(`/api/proposals/${PROPOSAL_ID}/apply`, () =>
        HttpResponse.json({
          proposal: profileProposal({
            ...decidedByAnna('applied', [{ label: 'Wärmeversorgung festhalten', ok: true }]),
            decidedBy: 'user_me',
            decidedByName: 'Mia Huber',
          }),
        })
      )
    )
    const user = userEvent.setup()
    render(profileCard)

    await user.click(await screen.findByRole('button', { name: 'Apply' }))

    expect(await screen.findByText('Project context updated.')).toBeInTheDocument()
    expect(screen.getByTestId('proposal-decided-by')).toHaveTextContent(/^Applied by Mia Huber · /)
    // The profile now holds the change: only „after“ is true to say.
    // (The question is still fading out beside its receipt: it is aria-hidden, the receipt is not.)
    expect(screen.getAllByText('Wärmepumpe').length).toBeGreaterThan(0)
    expect(screen.queryByRole('columnheader', { name: 'Before' })).toBeNull()
    expect(posts()).toEqual([`POST /api/proposals/${PROPOSAL_ID}/apply`])
    expect(invalidateProjectFacts).toHaveBeenCalledWith('proj-1')
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('Discard POSTs dismiss and leaves the project context as it was', async () => {
    serve(profileProposal())
    server.use(
      http.post(`/api/proposals/${PROPOSAL_ID}/dismiss`, () =>
        HttpResponse.json({ proposal: profileProposal(decidedByAnna('dismissed')) })
      )
    )
    const user = userEvent.setup()
    render(profileCard)

    await user.click(await screen.findByRole('button', { name: 'Discard' }))

    expect(await screen.findByText('Discarded. The project context is unchanged.')).toBeInTheDocument()
    expect(invalidateProjectFacts).not.toHaveBeenCalled()
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('hides the actions when the server says this reader may not decide', async () => {
    serve(profileProposal({ canDecide: false }))
    render(profileCard)

    expect(await screen.findByTestId('proposal-unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
  })

  it('says why the patch did not apply when the profile moved under it', async () => {
    serve(
      profileProposal(
        decidedByAnna('failed', [
          { label: 'Wärmeversorgung festhalten', ok: false, reason: 'Das Projekt wurde inzwischen geändert.' },
        ])
      )
    )
    render(profileCard)

    expect(await screen.findByText('Nothing could be applied. Nothing was changed.')).toBeInTheDocument()
    expect(screen.getByTestId('proposal-failures')).toHaveTextContent('inzwischen geändert')
  })

  it("shows a colleague's apply live, and refreshes what the thread's answers say about the project", async () => {
    useFakeStream()
    const served = serve(profileProposal())
    render(profileCard)

    await screen.findByRole('button', { name: 'Apply' })
    const stream = await openStream()
    await waitFor(() => expect(gets()).toHaveLength(2))
    served.current = profileProposal(decidedByAnna('applied', [{ label: 'Wärmeversorgung festhalten', ok: true }]))
    stream.say(hint('applied'))

    expect(await screen.findByText('Project context updated.')).toBeInTheDocument()
    expect(screen.getByTestId('proposal-decided-by')).toHaveTextContent(/^Applied by Anna Berger · /)
    expect(invalidateProjectFacts).toHaveBeenCalledWith('proj-1')
    expect(posts()).toEqual([])
  })
})

describe('GridCards hands a card its proposal_id', () => {
  const PROPOSAL_CARDS: Array<[string, GridCard]> = [
    [
      'memory_proposal',
      {
        type: 'memory_proposal',
        title: 'Remember this?',
        content: NOTE,
        kind: 'preference',
        confidence: 'high',
        supersedes: null,
        proposal_id: PROPOSAL_ID,
      },
    ],
    [
      'project_profile_patch',
      { type: 'project_profile_patch', title: 'Update', rationale: 'Because.', patch: PATCH, proposal_id: PROPOSAL_ID },
    ],
    [
      'file_operation_proposal',
      {
        type: 'file_operation_proposal',
        title: 'Move',
        operation: 'rename',
        operations: [{ document: 'a.pdf', new_display_name: 'b.pdf' }],
        note: null,
        proposal_id: PROPOSAL_ID,
      } as GridCard,
    ],
  ]

  it.each(PROPOSAL_CARDS)('%s reads the stored proposal and does not ask the message for a decision', async (_type, card) => {
    serve(memoryProposal())
    render(<GridCards cards={[card]} projectId="proj-1" messageId="msg-1" />)

    await waitFor(() => expect(requests).toContain(`GET /api/proposals/${PROPOSAL_ID}`))
    expect(setCardDecision).not.toHaveBeenCalled()
  })
})
