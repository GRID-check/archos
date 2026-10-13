/**
 * The wiring guard for interactive cards.
 *
 * `CARD_INTERACTIVITY` (card-decision.ts) is exhaustive over `GridCard['type']`,
 * so a newly generated card type fails `tsc` until someone classifies it. This
 * spec closes the other half: once a type is classified `'interactive'`, it
 * must ALSO be wired through `GridCards` with a `cardKey` and record its
 * outcome via `setCardDecision` — otherwise the decision dies on reload and the
 * card re-offers a write that already happened.
 *
 * Adding an interactive card type without teaching this spec how to settle it
 * fails the first test below. That is the intended failure: write the case,
 * and you will discover whether the wiring exists.
 *
 * The other half is the ratchet for `'live'` cards (the last `describe`). A live
 * card is a window onto server objects, and every decision on it is a write to
 * the object: the object is the record (ADR-0105, ADR-0109). So a live card
 * must NEVER write `cardInteractions`; the spec presses each control of each
 * live card against a spied store and fails if `setCardDecision` is touched.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridCard } from '@/shared/cards/schemas'
import { cardKeyOfDecisionKey, INTERACTIVE_CARD_TYPES, LIVE_CARD_TYPES } from './card-decision'
import { GridCardItem, GridCards, GridCardView } from './components/GridCards'
import { CARD_PREVIEW_FIXTURES } from './preview-fixtures'

const setCardDecision = vi.fn()

const mockStoreState = () => ({
  projectId: 'proj-1',
  currentConversation: { id: 'conv-1', messages: [{ id: 'msg-1', cardInteractions: undefined }] },
  conversations: [],
  setCardDecision,
})

vi.mock('@/features/chat/store', () => {
  const useChatStore = (selector: (s: unknown) => unknown) => selector(mockStoreState())
  // `useCardDecision` re-reads the store imperatively after writing, to detect a
  // write that could not land.
  useChatStore.getState = () => mockStoreState()
  return { useChatStore }
})

/**
 * One fixture per interactive card type: a renderable card plus the label of an
 * action that settles it. Keyed by card type so a missing entry is an explicit,
 * readable failure rather than silent under-coverage.
 */
const SETTLE_CASES: Partial<
  Record<GridCard['type'], { card: GridCard; action: string; response?: unknown }>
> = {
  project_profile_patch: {
    card: {
      type: 'project_profile_patch',
      title: 'Update brief',
      rationale: 'Learned the class.',
      patch: [{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK4' }],
    } as GridCard,
    // Reject settles without a network round trip — this spec is about wiring,
    // not about each card's own API contract (that lives in its own spec).
    action: 'Reject',
  },
  memory_proposal: {
    card: {
      type: 'memory_proposal',
      title: 'Save this finding?',
      content: 'The firm always uses REI 90 for GK4.',
      kind: 'preference',
      confidence: 'high',
    } as GridCard,
    action: 'No',
  },
  file_operation_proposal: {
    card: {
      type: 'file_operation_proposal',
      title: 'Move two files',
      operation: 'move',
      operations: [
        { document: 'Grundriss EG.pdf', source: 'projekt', current: '', target_folder: 'Einreichung' },
      ],
    } as GridCard,
    // Discard settles without touching a route, like Reject above: this spec
    // is about the wiring, and the accept path has its own spec.
    action: 'Discard',
  },
  document_draft: {
    card: {
      type: 'document_draft',
      title: 'Aktenvermerk – Fluchtweg',
      path: '/entwuerfe/aktenvermerk.md',
      bytes: 4820,
      version: 2,
      document_id: 'doc-1',
      version_id: 'ver-1',
      version_state: 'draft',
    } as GridCard,
    // Unlike the two above, this one HAS to reach its route: the card's only
    // decision is the submit, and there is no decline. So the case carries the
    // body the lifecycle client parses — a client that stopped agreeing with
    // the route's response shape would fail here rather than settle on nothing.
    action: 'Submit for approval',
    response: {
      version: {
        id: 'ver-1',
        documentId: 'doc-1',
        versionNumber: 1,
        state: 'in_review',
        contentType: 'text/markdown',
        fileSize: 10,
        contentHash: 'h1',
        submittedBy: 'user_1',
        submittedAt: '2026-09-10T00:00:00.000Z',
        reviewedBy: null,
        reviewedAt: null,
        approvedBy: null,
        approvedAt: null,
        publishedBy: null,
        publishedAt: null,
        reviewComment: null,
        createdBy: 'user_1',
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:00:00.000Z',
      },
    },
  },
}

describe('interactive card wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('has a settle case for every card classified as interactive', () => {
    const uncovered = INTERACTIVE_CARD_TYPES.filter((type) => !SETTLE_CASES[type])
    expect(
      uncovered,
      `Card type(s) ${uncovered.join(', ')} are classified 'interactive' in CARD_INTERACTIVITY but ` +
        'have no settle case here. Add one — and make sure the card takes messageId + cardKey and ' +
        'uses useCardDecision, or its answer will not survive a reload.',
    ).toEqual([])
  })

  for (const [type, testCase] of Object.entries(SETTLE_CASES)) {
    /** The body this card's route answers with, for the cases that need one. */
    const stubFetch = () =>
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => testCase.response ?? {} })),
      )

    it(`records the decision on the owning message for ${type}`, async () => {
      stubFetch()
      const user = userEvent.setup()
      render(<GridCards cards={[testCase.card]} projectId="proj-1" messageId="msg-1" />)

      await user.click(screen.getByRole('button', { name: testCase.action }))

      await waitFor(() => expect(setCardDecision).toHaveBeenCalled())
      const [messageId, cardKey] = setCardDecision.mock.calls[0]
      expect(messageId).toBe('msg-1')
      // The key GridCards hands down must be the positional card identity, so a
      // decision and the card it belongs to cannot drift apart. A card that
      // asks per item (`canvas_activity`) stores under `itemDecisionKey`, whose
      // card part is that same identity.
      expect(cardKeyOfDecisionKey(cardKey)).toBe(`${type}-0`)
    })

    // The same card is drawn ALONE when the answer placed it inline with a
    // `[[card:N]]` marker, and inside a FILTERED block when it did not. Its
    // identity has to be the original array index in both cases: renumber it
    // and every decision already recorded on this message names another card.
    it(`keys ${type} on its original index when drawn inline`, async () => {
      stubFetch()
      const user = userEvent.setup()
      render(
        <GridCardItem card={testCase.card} index={2} projectId="proj-1" messageId="msg-1" />,
      )

      await user.click(screen.getByRole('button', { name: testCase.action }))

      await waitFor(() => expect(setCardDecision).toHaveBeenCalled())
      expect(cardKeyOfDecisionKey(setCardDecision.mock.calls[0][1])).toBe(`${type}-2`)
    })

    /**
     * A surface that requires persistence gets NO decision when nothing owns
     * the card. The deep-research report tab is that surface: its cards come
     * from a job output, and the message carrying them is not always loaded
     * (`card-owner.ts`). Falling back to mount-local state there would take an
     * answer, fire the non-idempotent write behind it, and forget both — so the
     * action must not be on screen at all.
     */
    it(`offers no way to settle ${type} when the decision could not be kept`, () => {
      render(<GridCards cards={[testCase.card]} projectId="proj-1" decisionsMustPersist />)

      expect(screen.queryByRole('button', { name: testCase.action })).toBeNull()
      expect(setCardDecision).not.toHaveBeenCalled()
    })

    it(`keys ${type} on its original index in the fallback block`, async () => {
      stubFetch()
      const user = userEvent.setup()
      const filler = CARD_PREVIEW_FIXTURES.calculation!
      render(
        <GridCards
          cards={[filler, testCase.card]}
          indices={[1]}
          projectId="proj-1"
          messageId="msg-1"
        />,
      )

      expect(screen.queryByText('Platzhalter')).toBeNull()
      await user.click(screen.getByRole('button', { name: testCase.action }))

      await waitFor(() => expect(setCardDecision).toHaveBeenCalled())
      expect(cardKeyOfDecisionKey(setCardDecision.mock.calls[0][1])).toBe(`${type}-1`)
    })
  }

  // The second guard behind SURFACE_EXCLUDED_LEAVES: every leaf of a surface
  // shares the surface's index, so a leaf's key carries its id too.
  it('keys a leaf of a surface on its id as well as the surface index', async () => {
    const { card, action } = SETTLE_CASES.memory_proposal!
    const user = userEvent.setup()
    render(<GridCardView card={card} index={2} leafId="b" projectId="proj-1" messageId="msg-1" />)

    await user.click(screen.getByRole('button', { name: action }))

    await waitFor(() => expect(setCardDecision).toHaveBeenCalled())
    expect(setCardDecision.mock.calls[0][1]).toBe('memory_proposal-2.b')
  })
})

// ── Live cards: the object is the record ────────────────────────────────────

type User = ReturnType<typeof userEvent.setup>

interface LiveScenario {
  name: string
  /** Press one control (or one path through several) of the card. */
  press: (user: User) => Promise<void>
}

const annotationView = (id: string, number: number, status: string) => ({
  id,
  documentId: 'doc-1',
  number,
  page: 1,
  shape: 'point',
  x: 0.4,
  y: 0.3,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Laufbreite im Treppenhaus unter 1,20 m.',
  basis: null,
  authorKind: id === 'ann-9' ? 'person' : 'piloti',
  status,
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  fassungNumber: 1,
  onCurrentFassung: true,
  createdBy: 'user_1',
  createdByName: 'Anna',
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:01:00.000Z',
  acceptedBy: null,
  acceptedByName: null,
  closedBy: null,
  closedByName: null,
  closedAt: null,
  replies: [],
  canEdit: true,
  canDelete: false,
})

const proposedMark = (id: string, number: number) => ({
  action: 'proposed',
  annotation_id: id,
  number,
  page: 1,
  shape: 'point',
  x: 0.4,
  y: 0.3,
  kind: 'defect',
  body: 'Laufbreite im Treppenhaus unter 1,20 m.',
})

/**
 * One fixture per live card: a renderable card, the routes its objects answer
 * on, and every control it offers, each pressed in a fresh render. Keyed by
 * card type so a live card without a case is an explicit failure, not silent
 * under-coverage.
 */
const LIVE_CASES: Partial<
  Record<GridCard['type'], { card: GridCard; routes: (url: string, init?: RequestInit) => unknown; scenarios: LiveScenario[] }>
> = {
  canvas_activity: {
    card: {
      type: 'canvas_activity',
      document: { id: 'doc-1', name: 'Grundriss EG.pdf' },
      items: [
        proposedMark('ann-4', 4),
        proposedMark('ann-5', 5),
        proposedMark('ann-6', 6),
        // A change with no server record, so the browser-side replay is on offer.
        {
          action: 'changed',
          annotation_id: 'ann-9',
          number: 9,
          status: 'resolved',
          changes: [{ field: 'status', before: 'open', after: 'resolved' }],
          note: 'Erledigt.',
        },
      ],
    } as GridCard,
    routes: (url, init) => {
      if (init?.method === 'PATCH') {
        const id = decodeURIComponent(url.split('/').pop() ?? '')
        const status = JSON.parse(String(init.body)).status
        return { annotation: annotationView(id, Number(id.split('-')[1]), status) }
      }
      if (url.endsWith('/annotations')) {
        return {
          annotations: [
            annotationView('ann-4', 4, 'proposed'),
            annotationView('ann-5', 5, 'proposed'),
            annotationView('ann-6', 6, 'proposed'),
            annotationView('ann-9', 9, 'resolved'),
          ],
          canAnnotate: true,
        }
      }
      if (url.endsWith('/changes')) return { changes: [] }
      return {}
    },
    scenarios: [
      {
        name: 'taking one mark over',
        press: async (user) => user.click(await screen.findByRole('button', { name: 'Take over annotation 4' })),
      },
      {
        name: 'discarding one mark',
        press: async (user) => user.click(await screen.findByRole('button', { name: 'Discard annotation 5' })),
      },
      {
        name: 'taking every proposed mark over',
        press: async (user) => user.click(await screen.findByRole('button', { name: 'Take over all' })),
      },
      {
        name: 'discarding the rest, confirmed',
        press: async (user) => {
          await user.click(await screen.findByRole('button', { name: 'Discard the rest' }))
          await user.click(await screen.findByRole('button', { name: 'Discard' }))
        },
      },
      {
        name: 'undoing a change',
        press: async (user) => user.click(await screen.findByRole('button', { name: 'Undo the change to annotation 9' })),
      },
    ],
  },
}

class SeenObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe() {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
  unobserve() {}
  disconnect() {}
}

describe('live card wiring', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('IntersectionObserver', SeenObserver)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('has a case for every card classified as live', () => {
    const uncovered = LIVE_CARD_TYPES.filter((type) => !LIVE_CASES[type])
    expect(
      uncovered,
      `Card type(s) ${uncovered.join(', ')} are classified 'live' in CARD_INTERACTIVITY but have no case here. ` +
        'Add one that presses every control: a live card writes the OBJECT and never cardInteractions.',
    ).toEqual([])
  })

  for (const [type, testCase] of Object.entries(LIVE_CASES)) {
    for (const scenario of testCase.scenarios) {
      it(`${type}: ${scenario.name} writes the object and nothing on the message`, async () => {
        fetchMock = vi.fn((url: string, init?: RequestInit) =>
          Promise.resolve({ ok: true, status: 200, json: async () => testCase.routes(url, init) }),
        )
        vi.stubGlobal('fetch', fetchMock)
        const user = userEvent.setup()
        render(<GridCards cards={[testCase.card]} projectId="proj-1" messageId="msg-1" />)

        await scenario.press(user)

        // The control really acted (a vacuous pass is no ratchet): it wrote the object.
        await waitFor(() =>
          expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true),
        )
        expect(setCardDecision).not.toHaveBeenCalled()
      })
    }
  }
})
