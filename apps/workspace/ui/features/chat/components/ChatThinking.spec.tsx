import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ChatThinking } from './ChatThinking'
import { translatorFor } from '@/i18n/namespace'
import { chatCopy } from '@/i18n/namespaces/chat'
import { useLayoutStore } from '@/features/layout/store'
import { storedStep } from '@/test-utils/wire-v2-steps'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import {
  MOCKUP_QUESTION,
  failedCallCitations,
  failedCallScene,
  foldScene,
  mockupCitations,
  mockupScene,
  singleReadCitations,
  singleReadScene,
} from '@/test-utils/work-list-scenes'
import { PRODUCT_NAME } from '@/lib/brand'

/** The copy as the English dictionary words it, so a retune of a phrase is not a broken spec. */
const tEn = translatorFor(chatCopy, 'en')
/** Text as read, with the no-break spaces that hold a count to its noun as plain ones. */
const plain = (text: string | null): string => (text ?? '').replace(/\u00A0/g, ' ')

const motionPref = vi.hoisted(() => ({ reduced: false }))
vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => motionPref.reduced }))

/** A running tool this build has no name for: it speaks on no line and earns no chip. */
const createStep = (overrides: Partial<StoredThinkingStep> = {}): StoredThinkingStep => ({
  id: 'step-1',
  userMessageId: 'msg-1',
  kind: 'tool',
  tool: 'acme_internal',
  isComplete: false,
  timestamp: '2024-01-15T14:30:00',
  ...overrides,
})

const oibSources = (hits: Array<{ name: string; detail: string }>) =>
  storedStep({
    id: 'sources:0:knowledge_search:1',
    kind: 'sources',
    tool: 'knowledge_search',
    round: 0,
    lanes: [
      { key: 'building_law_oib', label: 'OIB-Richtlinie', kind: 'building_law', hit_count: hits.length, sources: hits },
    ],
  })

/** Expand outer Herleitung, then technical intermediate-steps section. The raw
 *  technical steps are now a profile opt-in (default off), so enable the
 *  preference before drilling into them. */
const expandToSteps = async (user: ReturnType<typeof userEvent.setup>) => {
  useLayoutStore.setState({ showTechnicalReasoning: true })
  await user.click(screen.getByText(/^Trace( ·|$)/))
  await user.click(await screen.findByText('Intermediate steps'))
}

/** The raw technical step list. Scoped queries are required because the
 *  executed-step chips above it repeat the same step names. */
const stepList = () => screen.getByRole('list', { name: 'Thinking steps' })

/** The visible header line. The phase also sits in a status region outside it. */
const header = () => within(screen.getAllByRole('button')[0])

describe('ChatThinking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default experience: technical steps hidden unless the profile opts in.
    useLayoutStore.setState({ showTechnicalReasoning: false })
    motionPref.reduced = false
  })

  describe('technical reasoning preference', () => {
    test('hides the technical steps section by default', async () => {
      const user = userEvent.setup()
      render(<ChatThinking steps={[createStep()]} />)
      await user.click(screen.getByText(/^Trace( ·|$)/))
      expect(screen.queryByText('Intermediate steps')).not.toBeInTheDocument()
    })

    test('shows the technical steps section when the preference is on', async () => {
      const user = userEvent.setup()
      useLayoutStore.setState({ showTechnicalReasoning: true })
      render(<ChatThinking steps={[createStep()]} />)
      await user.click(screen.getByText(/^Trace( ·|$)/))
      expect(await screen.findByText('Intermediate steps')).toBeInTheDocument()
    })
  })

  describe('turn-driven autoOpen (live expands, done collapses)', () => {
    // The expanded panel renders the graph, so its presence is the proxy for
    // "expanded". (The attached-files footer that served before went by the
    // 2026-10 value test: an attached file that was read is a source card.)
    const files = [{ id: 'file-1', fileName: 'plan.pdf' }]

    test('autoOpen expands the reasoning without a click (live turn)', () => {
      render(<ChatThinking steps={[createStep()]} autoOpen messageFiles={files} />)
      expect(screen.getByTestId('reasoning-flow')).toBeInTheDocument()
    })

    test('autoOpen=false keeps the reasoning collapsed (past/done turn)', () => {
      render(<ChatThinking steps={[createStep()]} autoOpen={false} messageFiles={files} />)
      expect(screen.queryByTestId('reasoning-flow')).not.toBeInTheDocument()
    })

    test('a live→done autoOpen transition collapses the reasoning', async () => {
      const { rerender } = render(
        <ChatThinking steps={[createStep()]} autoOpen messageFiles={files} />
      )
      expect(screen.getByTestId('reasoning-flow')).toBeInTheDocument()
      rerender(<ChatThinking steps={[createStep()]} autoOpen={false} messageFiles={files} />)
      await waitFor(() => expect(screen.queryByTestId('reasoning-flow')).not.toBeInTheDocument())
    })

    test('the fold: the turn closes what it opened, in the render the prop changes', () => {
      const { rerender } = render(
        <ChatThinking steps={[createStep()]} isThinking autoOpen messageFiles={files} />
      )
      rerender(
        <ChatThinking steps={[createStep()]} isThinking answering autoOpen={false} messageFiles={files} />
      )
      // The content is leaving (its exit runs), and the header is still live.
      expect(screen.getByLabelText('Thinking in progress')).toBeInTheDocument()
      expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument()
    })

    test('a HITL wait does not force the panel open: the choice is answered in its prompt card', () => {
      const { rerender } = render(
        <ChatThinking steps={[createStep()]} isThinking autoOpen={false} messageFiles={files} />
      )
      rerender(
        <ChatThinking steps={[createStep()]} isThinking={false} isWaiting autoOpen={false} messageFiles={files} />
      )
      expect(screen.queryByTestId('reasoning-flow')).not.toBeInTheDocument()
    })

    test('the live panel shows the whole graph: no capped, bottom-pinned window that cut its first steps off', async () => {
      const user = userEvent.setup()
      const { container } = render(
        <ChatThinking steps={[createStep()]} isThinking autoOpen={false} messageFiles={files} />
      )
      await user.click(screen.getByRole('button', { expanded: false }))
      expect(container.querySelector('[class*="max-h-"]')).toBeNull()
      expect(container.querySelector('[class*="overflow-y-auto"]')).toBeNull()
    })

    test('while the turn works the header icon spins, as the working sign people watch for', () => {
      const { container } = render(<ChatThinking steps={[createStep()]} isThinking messageFiles={files} />)
      expect(screen.getByLabelText('Thinking in progress')).toBeInTheDocument()
      expect(container.querySelector('.animate-spin')).not.toBeNull()
    })

    test('a panel the reader opened is not folded or reopened by the turn', async () => {
      const user = userEvent.setup()
      const { rerender } = render(
        <ChatThinking steps={[createStep()]} isThinking autoOpen={false} messageFiles={files} />
      )
      await user.click(screen.getByRole('button', { expanded: false }))
      expect(screen.getByTestId('reasoning-flow')).toBeInTheDocument()
      rerender(<ChatThinking steps={[createStep()]} isThinking autoOpen messageFiles={files} />)
      rerender(
        <ChatThinking steps={[createStep()]} isThinking answering autoOpen={false} messageFiles={files} />
      )
      expect(screen.getByTestId('reasoning-flow')).toBeInTheDocument()
    })
  })

  describe('the header from the send to the settle', () => {
    test('while the answer streams it stays live, names the panel, and its icon keeps spinning', () => {
      const { container } = render(<ChatThinking steps={[createStep()]} isThinking answering />)

      expect(screen.getByLabelText('Thinking in progress')).toBeInTheDocument()
      expect(screen.getByText('Trace')).toBeInTheDocument()
      expect(header().queryByText('Working on a response …')).not.toBeInTheDocument()
      // Until the turn settles the spinner says the agent is still at it.
      expect(container.querySelector('[data-slot="spinner"]')).not.toBeNull()
    })

    test('a stopped turn shows „Stopped", never the green check', () => {
      render(<ChatThinking steps={[createStep()]} isThinking={false} isStopped />)

      expect(screen.getByText('Stopped')).toBeInTheDocument()
      expect(screen.queryByText('Done')).not.toBeInTheDocument()
    })

    test('the timer counts from the question, so a late mount does not restart it', () => {
      const since = new Date(Date.now() - 12_000)
      render(<ChatThinking steps={[createStep()]} isThinking since={since} />)

      expect(screen.getByText('12s')).toBeInTheDocument()
    })

    test('at the settle the figure goes: no one checks an answer by its seconds (2026-10 value test)', async () => {
      const since = new Date(Date.now() - 12_000)
      const { rerender } = render(<ChatThinking steps={[createStep()]} isThinking since={since} />)
      expect(screen.getByText('12s')).toBeInTheDocument()
      rerender(
        <ChatThinking steps={[createStep()]} isThinking={false} since={since} answerDurationMs={12_400} />
      )
      await waitFor(() => expect(screen.queryByText('12s')).not.toBeInTheDocument())
    })

    test('the trigger is named by the phase, not the per-step phrase, which is never announced', () => {
      const steps = [
        storedStep({
          id: 'status:retrieval:0',
          kind: 'retrieval',
          round: 0,
          key: 'status.retrieval.withQuery',
          values: { corpus: 'knowledge', query: 'Fluchtweg' },
        }),
      ]
      render(<ChatThinking steps={steps} isThinking />)

      const trigger = screen.getAllByRole('button')[0]
      // The header's own join holds the dot to the word before it (NBSP).
      expect(trigger).toHaveAccessibleName(/^Thinking in progress · Trace\u00A0· 1\sstep$/)
      const status = screen.getAllByRole('status').find((el) => el.getAttribute('aria-live') === 'polite')
      expect(status).toHaveTextContent('Thinking in progress')
      expect(status).not.toHaveTextContent('Fluchtweg')
    })

    test('a restored turn grows no timer', () => {
      render(<ChatThinking steps={[createStep()]} isThinking={false} answerDurationMs={11_600} />)
      expect(screen.queryByText('12s')).not.toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    test('renders nothing when no steps provided', () => {
      render(<ChatThinking steps={[]} />)

      expect(screen.queryByText('Working on a response...')).not.toBeInTheDocument()
      expect(screen.queryByText('Done')).not.toBeInTheDocument()
      expect(screen.queryByText(/^Trace/)).not.toBeInTheDocument()
    })
  })

  describe('status header', () => {
    test('shows spinner and a live activity label when isThinking is true', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={true} />)

      expect(screen.getByLabelText('Thinking in progress')).toBeInTheDocument()
      // A tool step never speaks on the live line: only a turn event does. The
      // calm generic stands in, never the identifier.
      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
      expect(screen.queryByText(/acme_internal/)).not.toBeInTheDocument()
    })

    test('shows the newest turn event the backend reported, in the reader\'s words', () => {
      const steps = [
        storedStep({
          id: 'status:retrieval:0',
          kind: 'retrieval',
          round: 0,
          key: 'status.retrieval.withQuery',
          values: { corpus: 'knowledge', query: 'Fluchtweg' },
        }),
        createStep({ id: 'tool:1', tool: 'knowledge_search' }),
      ]

      render(<ChatThinking steps={steps} isThinking={true} />)

      // The backend's event in the reader's words: the corpus phrase is the
      // dictionary's, the query the reader's own.
      expect(screen.getByText(/^Searching .+: “Fluchtweg”$/)).toBeInTheDocument()
    })

    test('settled, the label stays the summary: no „Done" word moves it', () => {
      // The settle swaps only the glyph and freezes the figure. „Done" in the
      // label's place moved the summary from the left of the row to the right
      // in the frame the turn ended.
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={false} />)

      expect(screen.queryByLabelText('Thinking in progress')).not.toBeInTheDocument()
      const trigger = screen.getByRole('button')
      expect(trigger).toHaveAccessibleName(/Done · Trace/)
      expect(within(trigger).queryByText('Done')).not.toBeInTheDocument()
      expect(within(trigger).getAllByText(/^Trace/)).toHaveLength(1)
    })

    test('the answer streaming and the settle show the summary in the same place', () => {
      const steps = [createStep()]
      const { rerender } = render(<ChatThinking steps={steps} isThinking answering />)
      const before = within(screen.getByRole('button')).getByText(/^Trace/)

      rerender(<ChatThinking steps={steps} isThinking={false} answering />)

      // The same node: not re-keyed, so not cross-faded either.
      expect(within(screen.getByRole('button')).getByText(/^Trace/)).toBe(before)
    })

    test.each([
      ['handed_off', tEn('thinking.handedOff')],
      ['refused', 'Not handled'],
      ['failed', 'Failed'],
    ] as const)('a turn that ended %s is not „Done"', (endedAs, word) => {
      render(<ChatThinking steps={[createStep()]} isThinking={false} endedAs={endedAs} />)

      const trigger = screen.getByRole('button')
      expect(within(trigger).getByText(word)).toBeInTheDocument()
      expect(trigger).not.toHaveAccessibleName(/Done/)
    })

    test('the trigger is marked for the lifecycle fixtures', () => {
      render(<ChatThinking steps={[createStep()]} isThinking />)
      expect(screen.getByRole('button')).toHaveAttribute('data-derivation-trigger')
    })

    test('defaults to isThinking true', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} />)

      expect(screen.getByLabelText('Thinking in progress')).toBeInTheDocument()
      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
    })

    test('falls back to the generic working copy when no step can be phrased', () => {
      const unknownKey = storedStep({ id: 'status:x', kind: 'status', slot: 'x', key: 'status.nope' })
      render(<ChatThinking steps={[unknownKey]} isThinking />)

      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
    })

    test('shows warning icon and interrupted text when isInterrupted is true', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={false} isInterrupted={true} />)

      expect(header().getByText('Interrupted')).toBeInTheDocument()
      expect(screen.queryByText('Done')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Thinking in progress')).not.toBeInTheDocument()
    })

    test('isThinking takes priority over isInterrupted', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={true} isInterrupted={true} />)

      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
      expect(screen.queryByText('Interrupted')).not.toBeInTheDocument()
    })

    test('shows the calm "checking" copy while recovery is pending, not the lost notice (FIX 3)', () => {
      const steps = [createStep()]

      render(
        <ChatThinking
          steps={steps}
          isThinking={false}
          isInterrupted={true}
          isRecoveryPending={true}
        />
      )

      // Header chip + inline notice both show the reconnecting/checking copy …
      expect(header().getByText('Fetching the answer')).toBeInTheDocument()
      expect(
        screen.getByText(`${PRODUCT_NAME} is still working — the answer appears here as soon as it is ready …`)
      ).toBeInTheDocument()
      // … and the "answer lost" copy must NOT appear while we are still checking.
      expect(screen.queryByText('Interrupted')).not.toBeInTheDocument()
      expect(
        screen.queryByText('This answer was not finished, and the server has none. Please send the question again.')
      ).not.toBeInTheDocument()
    })

    test('falls back to the lost/interrupted copy once recovery has settled (not pending)', () => {
      const steps = [createStep()]

      render(
        <ChatThinking
          steps={steps}
          isThinking={false}
          isInterrupted={true}
          isRecoveryPending={false}
        />
      )

      expect(header().getByText('Interrupted')).toBeInTheDocument()
      expect(
        screen.getByText('This answer was not finished, and the server has none. Please send the question again.')
      ).toBeInTheDocument()
      expect(screen.queryByText('Fetching the answer')).not.toBeInTheDocument()
    })

    test('shows clock icon and waiting text when isWaiting is true', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={false} isWaiting={true} />)

      expect(header().getByText('Waiting for response')).toBeInTheDocument()
      expect(screen.queryByText('Done')).not.toBeInTheDocument()
      expect(screen.queryByText('Interrupted')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Thinking in progress')).not.toBeInTheDocument()
    })

    test('isWaiting takes priority over isInterrupted', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={false} isWaiting={true} isInterrupted={true} />)

      expect(header().getByText('Waiting for response')).toBeInTheDocument()
      expect(screen.queryByText('Interrupted')).not.toBeInTheDocument()
    })

    test('isThinking takes priority over isWaiting', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={true} isWaiting={true} />)

      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
      expect(screen.queryByText('Waiting for response')).not.toBeInTheDocument()
    })
  })

  describe('collapse/expand toggle', () => {
    test('the header counts no steps, and no source is no clause', () => {
      // A step count read as "the agent took 19 turns", and "0 sources" reads
      // as a failure to find anything.
      render(<ChatThinking steps={[createStep(), createStep({ id: 'step-2' })]} />)

      expect(screen.getByText('Trace')).toBeInTheDocument()
      expect(screen.queryByText(/step/)).not.toBeInTheDocument()
      expect(screen.queryByText(/source/)).not.toBeInTheDocument()
    })

    test('step list is collapsed by default', () => {
      const steps = [createStep({ kind: 'status', tool: undefined, slot: 'decision:routing' })]

      render(<ChatThinking steps={steps} />)

      expect(screen.getByText('Trace')).toBeInTheDocument()
      expect(screen.queryByText('decision:routing')).not.toBeInTheDocument()
    })

    test('expands technical steps after second toggle', async () => {
      const user = userEvent.setup()
      const steps = [createStep({ kind: 'status', tool: undefined, slot: 'decision:routing' })]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      expect(within(stepList()).getByText('decision:routing')).toBeVisible()
    })
  })

  describe('source fan-out', () => {
    test('a still-running turn never reports a source as unused', async () => {
      // "abgerufen, nicht zitiert" is a claim about the FINISHED answer. While
      // the turn streams nothing has been cited yet, so every retrieved
      // document read as discarded — including the ones about to be cited a
      // second later.
      const user = userEvent.setup()
      const steps = [
        oibSources([{ name: 'OIB-RL_2_Brandschutz.pdf', detail: 'p.12' }]),
      ]

      const { rerender } = render(<ChatThinking steps={steps} isThinking={true} />)
      await user.click(screen.getByText(/^Trace( ·|$)/))
      expect(screen.queryByText(/retrieved, not cited/)).not.toBeInTheDocument()

      // Once the turn lands and the answer cited nothing from it, the verdict
      // becomes true and is stated: the document folds into the dashed card.
      rerender(<ChatThinking steps={steps} isThinking={false} />)
      expect(screen.getByText(tEn('thinking.node.uncited.name', { count: 1 }))).toBeInTheDocument()
    })

    test('renders per-document source cards from traceLanes', async () => {
      const user = userEvent.setup()
      const steps = [
        oibSources([
                { name: 'OIB-RL_2_Brandschutz.pdf', detail: 'p.12' },
                { name: 'OIB-RL_2_Brandschutz.pdf', detail: 'p.18' },
              ]),
      ]

      render(<ChatThinking steps={steps} isThinking={false} />)

      expect(header().getByText(/^Trace ·/)).toHaveTextContent('Trace · 1 source')

      await user.click(screen.getByText(/^Trace( ·|$)/))

      // Uncited, the document folds into the dashed card; opening it shows the card.
      // The fold is named by what it shows (count and names), never a label
      // that hides them; the tab („Not cited“) describes it.
      const fold = screen.getByRole('button', {
        name: `${tEn('thinking.node.uncited.name', { count: 1 })} OIB-Richtlinie 2`,
      })
      expect(fold).toHaveAttribute('aria-expanded', 'false')
      expect(fold).toHaveAccessibleDescription(tEn('thinking.node.uncited.pill'))
      await user.click(fold)

      // The card shows the DISPLAY name; the raw corpus filename only survives
      // on the tooltip, so a user never reads `oib-rl_2_ausgabe_mai_2023.pdf`.
      const name = screen.getByText('OIB-Richtlinie 2')
      expect(name).toBeVisible()
      expect(name).toHaveAttribute('title', expect.stringContaining('OIB-RL_2_Brandschutz.pdf'))
      expect(screen.queryByText('OIB-RL_2_Brandschutz.pdf')).not.toBeInTheDocument()
      // A place, not a count: the hit tally went by the 2026-10 value test.
      expect(screen.queryByText('2 hits')).not.toBeInTheDocument()
      // The tab names the lane in the reader's language (the wire sends it in German).
      expect(screen.getByText(/^OIB(-Richtlinie| guideline)$/)).toBeVisible()
    })
  })

  describe('step list rendering', () => {
    test('names each row by its kind: a tool in the chip words, a slot verbatim', async () => {
      const user = userEvent.setup()
      const steps = [
        createStep({ id: '1', kind: 'status', tool: undefined, slot: 'decision:routing' }),
        createStep({ id: '2', tool: 'web_search_tool' }),
        createStep({ id: '3', tool: 'acme_internal' }),
        storedStep({ id: 'clarification', kind: 'clarification', max_turns: 3 }),
      ]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      const list = within(stepList())
      expect(list.getByText('decision:routing')).toBeVisible()
      expect(list.getByText('Web search')).toBeVisible()
      expect(list.getByText('acme_internal')).toBeVisible()
      expect(list.getByText('Clarifying question')).toBeVisible()
    })

    test('shows timestamps for each step', async () => {
      const user = userEvent.setup()
      const steps = [createStep({ timestamp: '2024-01-15T14:30:00' })]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    })

    test('step list has correct ARIA role', async () => {
      const user = userEvent.setup()
      const steps = [createStep()]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      expect(screen.getByRole('list', { name: 'Thinking steps' })).toBeInTheDocument()
    })
  })

  describe('styling', () => {
    test('outer container has soft surface styling', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} />)

      const triggerText = screen.getByText('Trace')
      const outerDiv = triggerText.closest('.rounded-surface.shadow-xs')
      expect(outerDiv).toBeInTheDocument()
    })
  })

  describe('no attached-files footer', () => {
    // The footer listing the message's attachments went by the 2026-10 value
    // test: an attachment the turn read is a source card in the graph, and one
    // it did not read says nothing about the answer.
    test('lists no attachment as a chip', () => {
      const steps = [createStep()]
      const messageFiles = [
        { id: 'file-1', fileName: 'document.pdf' },
        { id: 'file-2', fileName: 'report.docx' },
      ]

      render(<ChatThinking steps={steps} defaultOpen messageFiles={messageFiles} />)

      expect(screen.getByTestId('reasoning-flow')).toBeInTheDocument()
      expect(screen.queryByText('document.pdf')).not.toBeInTheDocument()
      expect(screen.queryByText('report.docx')).not.toBeInTheDocument()
    })
  })

  /**
   * The phantom web search.
   *
   * Every data source is enabled by default and `web_search` is first in the
   * registry, so the old basis footer claimed "Websuche" inside the Herleitung
   * on EVERY turn — a bare greeting included, where the backend drops all
   * data-source tools before the model ever sees them. Availability is the
   * constant, activation is the event: only the `Ran:` row, derived from the
   * turn's `tool` and `skill` steps, may say what a turn did.
   */
  describe('enabled data sources are never rendered as activity', () => {
    const enabled = ['web_search', 'knowledge_layer', 'ris']

    test('a turn with sources enabled but no executed search renders no source-activity chip', () => {
      // A greeting: the answer was composed, no search tool ran.
      const steps = [storedStep({ id: 'status:synthesis', kind: 'status', slot: 'synthesis', key: 'status.synthesis' })]

      render(
        <ChatThinking
          steps={steps}
          isThinking={false}
          defaultOpen
          enabledDataSources={enabled}
        />
      )

      // Nothing ran that has a chip, and nothing anywhere claims a search happened.
      expect(screen.queryByText('Ran:')).not.toBeInTheDocument()
      expect(screen.queryByText('Web search')).not.toBeInTheDocument()
      expect(screen.queryByText('Web Search')).not.toBeInTheDocument()
      expect(screen.queryByText('RIS')).not.toBeInTheDocument()
      expect(screen.queryByText('Knowledge')).not.toBeInTheDocument()
      expect(screen.queryByText('OIB knowledge')).not.toBeInTheDocument()
      expect(screen.queryByText('Selected Data Sources:')).not.toBeInTheDocument()
      expect(screen.queryByTestId('reasoning-flow')).not.toBeInTheDocument()
    })

    test('an executed web search IS reported — the fix removes the false claim, not the true one', () => {
      const steps = [
        createStep({ tool: 'web_search_tool', isComplete: true }),
      ]

      render(
        <ChatThinking
          steps={steps}
          isThinking={false}
          defaultOpen
          enabledDataSources={enabled}
        />
      )

      expect(screen.getByText('Web search')).toBeVisible()
    })

    test('enabled sources alone never conjure a derivation panel', () => {
      const { container } = render(
        <ChatThinking steps={[]} isThinking={false} enabledDataSources={enabled} />
      )

      expect(container).toBeEmptyDOMElement()
    })
  })

  /**
   * Skill activation, rendered.
   *
   * The chip row is where a reader finds out a skill shaped this answer while
   * the turn is still open; the post-hoc `SkillsUsedDisclosure` says the same
   * thing under the finished answer. They never coexist (this panel only shows
   * while thinking), and they use the same label authority so they cannot
   * disagree.
   */
  describe('skill activity', () => {
    const skillStep = (name: string, payload: Record<string, unknown>) =>
      storedStep({ id: `skill:${name}`, kind: 'skill', skill: name, ...payload })

    test('each activated skill gets its own chip, named by its title', () => {
      render(
        <ChatThinking
          isThinking
          defaultOpen
          steps={[
            skillStep('oib-brandschutz', {
              phase: 'activated',
              title: 'Brandschutznachweis',
            }),
            skillStep('schallschutz', { phase: 'activated' }),
          ]}
        />
      )

      expect(screen.getByText('Skill: Brandschutznachweis')).toBeVisible()
      // No authored title: the bare identifier, verbatim and in mono.
      const bare = screen.getByText('schallschutz')
      expect(bare).toBeVisible()
      expect(bare).toHaveClass('font-mono')
      expect(screen.queryByText(/Use Skill/i)).not.toBeInTheDocument()
    })

    test('an offered-but-unused skill claims nothing', () => {
      const { container } = render(
        <ChatThinking
          isThinking
          defaultOpen
          steps={[skillStep('a', { phase: 'offered', count: 1 })]}
        />
      )

      expect(container.textContent).not.toContain('Skill')
    })

    test('the chips stand down once the answer lands — the disclosure owns the post-hoc claim', () => {
      // `SkillsUsedDisclosure` sits under the finished answer and reports the
      // same activations with their descriptions. One fact, one owner.
      render(
        <ChatThinking
          isThinking={false}
          defaultOpen
          steps={[
            skillStep('oib-brandschutz', {
              phase: 'loaded',
              title: 'Brandschutznachweis',
            }),
          ]}
        />
      )

      expect(screen.queryByText('Skill: Brandschutznachweis')).not.toBeInTheDocument()
    })
  })

  describe('reasoning chain nodes', () => {
    const expandChain = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByText(/^Trace( ·|$)/))
    }

    test('framing node restates the user question', async () => {
      const user = userEvent.setup()
      const steps = [createStep()]

      render(<ChatThinking steps={steps} userQuestion="Wie viele Rettungswege brauche ich?" />)

      await expandChain(user)

      // The framing node restates the question (its "Framing" eyebrow labels it);
      // the leaner node no longer shows a separate "Question understood" title.
      expect(screen.getByText('Framing')).toBeVisible()
      expect(
        screen.getByText(/Wie viele Rettungswege brauche ich\?/)
      ).toBeVisible()
    })

    test('assessment node does NOT restate the confidence verdict (deduped to the answer card)', async () => {
      const user = userEvent.setup()
      const steps = [createStep()]

      render(<ChatThinking steps={steps} answerConfidence="high" />)

      await expandChain(user)

      // The trust verdict (confidence) now lives once, on the answer card — it is
      // no longer duplicated inside the Herleitung's assessment node (P1-2).
      expect(screen.queryByText('Confidence: high')).not.toBeInTheDocument()
    })

    test('the last card is „Grundlagen · Entwurf“: the cited law, what supports it, and what stayed open', () => {
      render(
        <ChatThinking
          steps={foldScene(mockupScene())}
          citations={mockupCitations()}
          isThinking={false}
          defaultOpen
          userQuestion={MOCKUP_QUESTION}
        />
      )
      expect(screen.getByText('Basis · Draft')).toBeVisible()
      expect(screen.getByText('Legal basis')).toBeVisible()
      // Each cited line leads with the answer's own marker, then the document.
      const lines = screen.getAllByTestId('basis-group')
      expect(lines[0]).toHaveTextContent('1 OIB-Richtlinie 2, Ausgabe Mai 2023, Sec. 3.1.1')
      expect(
        within(lines[0]!).getByRole('button', { name: /^Source 1:/ })
      ).toHaveAttribute('data-citation-marker', '1')
      expect(screen.getByText('Supported by')).toBeVisible()
      expect(lines[1]).toHaveTextContent('2 Einreichplan EG, p. 2')
      expect(within(lines[1]!).getByRole('button', { name: /^Source 2:/ })).toBeVisible()
      // No text marker is left behind.
      expect(lines[0]).not.toHaveTextContent('[1]')
      // „Open“ names the document as its card does (B14): the call said
      // „OIB-RL 2, Ausgabe 2023“, the card „OIB-Richtlinie 2, Ausgabe Mai 2023“.
      const open = screen.getByTestId('basis-open')
      expect(open).toHaveTextContent(/OIB.Richtlinie 2, Ausgabe Mai 2023\b.*Brandabschnitt Tiefgarage/)
      expect(open).not.toHaveTextContent(/OIB.RL 2/)
      // A draft's basis, never a verdict; a gap stated as the gap.
      expect(document.body).not.toHaveTextContent(/proven|No information found/i)
    })

    test('assessment node is hidden without confidence or citations', async () => {
      const user = userEvent.setup()
      const steps = [createStep()]

      render(<ChatThinking steps={steps} userQuestion="Frage?" />)

      await expandChain(user)

      expect(screen.queryByText('Backed by')).not.toBeInTheDocument()
    })
  })

  describe("the Herleitung cites with the answer's marker", () => {
    const renderSettled = () =>
      render(
        <ChatThinking
          steps={foldScene(mockupScene())}
          citations={mockupCitations()}
          answerId="answer-1"
          isThinking={false}
          defaultOpen
          userQuestion={MOCKUP_QUESTION}
        />
      )

    test('a cited source card carries a marker button, not the text „[N]“', () => {
      renderSettled()
      const groups = Array.from(document.querySelectorAll('[data-source-card-markers]'))
      expect(groups.length).toBeGreaterThan(0)
      for (const group of groups) {
        expect(group.querySelector('button[data-citation-marker]')).not.toBeNull()
        expect(group).not.toHaveTextContent(/\[\d+\]/)
      }
    })

    test('no button sits inside another button', () => {
      renderSettled()
      expect(document.querySelectorAll('button button')).toHaveLength(0)
    })

    test("a press on a card's marker is not a tap on the card", async () => {
      const user = userEvent.setup()
      renderSettled()
      const marker = document.querySelector<HTMLElement>(
        '[data-source-card-markers] button[data-citation-marker]'
      )!
      const card = marker.closest<HTMLElement>('[data-source-card]')!
      expect(card).not.toHaveAttribute('data-link')
      await user.click(marker)
      expect(card).not.toHaveAttribute('data-link', 'selected')
      // The card's own tap still links it to the rows of its calls.
      await user.click(card)
      expect(card).toHaveAttribute('data-link', 'selected')
    })

    const conceptCard = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-source-card]')).find((el) =>
        /Brandschutzkonzept/.test(el.textContent ?? '')
      )!
    const pressedRows = () =>
      document.querySelectorAll('[data-testid="work-row-link"][aria-pressed="true"]')

    test('a card is a keyboard control: Tab reaches it, Enter and Space toggle it and link its rows', async () => {
      const user = userEvent.setup()
      renderSettled()
      const card = conceptCard()
      const toggle = card.querySelector<HTMLElement>('[data-source-card-toggle]')!
      expect(toggle.tagName).toBe('BUTTON')
      // Named by the document, as the card names it.
      expect(toggle).toHaveAccessibleName(/Brandschutzkonzept/)
      // It wraps nothing (not the chip, not the marker) and sits in no button.
      expect(toggle.childElementCount).toBe(0)
      expect(toggle.parentElement?.closest('button')).toBeNull()

      for (let i = 0; i < 100 && document.activeElement !== toggle; i++) await user.tab()
      expect(toggle).toHaveFocus()
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
      expect(pressedRows()).toHaveLength(0)

      await user.keyboard('{Enter}')
      expect(toggle).toHaveAttribute('aria-pressed', 'true')
      expect(card).toHaveAttribute('data-link', 'selected')
      expect(pressedRows().length).toBeGreaterThan(0)

      await user.keyboard(' ')
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
      expect(card).not.toHaveAttribute('data-link')
      expect(pressedRows()).toHaveLength(0)
    })

    test('a receded card is dimmed once, never on top of the uncited dimming', async () => {
      const user = userEvent.setup()
      renderSettled()
      // Open every fold, so the uncited cards stand too.
      for (const fold of screen.getAllByTestId('uncited-fold'))
        await user.click(within(fold).getByRole('button'))
      expect(document.querySelectorAll('[data-source-card] .border-dashed').length).toBeGreaterThan(0)
      await user.click(conceptCard().querySelector<HTMLElement>('[data-source-card-toggle]')!)
      const receded = Array.from(document.querySelectorAll('[data-link="receded"]'))
      expect(receded.length).toBeGreaterThan(0)
      for (const el of receded) {
        expect(el).toHaveClass('opacity-60')
        expect(el.querySelector('.opacity-75, .opacity-40')).toBeNull()
      }
      // Nowhere does one dimming sit inside another.
      for (const el of Array.from(document.querySelectorAll('.opacity-60, .opacity-75')))
        expect(el.parentElement?.closest('.opacity-60, .opacity-75')).toBeNull()
    })

    test('the open fold is a plain text button under the last uncited card, with no tab', async () => {
      const user = userEvent.setup()
      renderSettled()
      const fold = screen.getAllByTestId('uncited-fold')[0]!
      const column = fold.closest<HTMLElement>('[role="list"]')!
      expect(fold.querySelector('.card-eyebrow')).not.toBeNull()
      await user.click(within(fold).getByRole('button'))

      const open = within(column).getByTestId('uncited-fold')
      const hide = within(open).getByRole('button', { name: tEn('thinking.node.uncited.hide') })
      expect(hide).toHaveAttribute('aria-expanded', 'true')
      expect(hide).not.toHaveClass('border-dashed')
      expect(open.querySelector('.card-eyebrow')).toBeNull()
      const items = within(column).getAllByRole('listitem')
      expect(items.at(-1)).toBe(open)
      expect(items.at(-2)).toHaveAttribute('data-source-card')

      await user.click(hide)
      const closed = within(column).getByTestId('uncited-fold')
      expect(within(closed).getByRole('button')).toHaveAttribute('aria-expanded', 'false')
      expect(closed.querySelector('.card-eyebrow')).not.toBeNull()
    })
  })

  describe('the header at a glance (2026-10)', () => {
    test('settled: the steps, what the answer cites, and the one worst warning', () => {
      render(
        <ChatThinking
          steps={foldScene(mockupScene())}
          citations={mockupCitations()}
          isThinking={false}
        />
      )
      const trigger = screen.getByRole('button')
      expect(within(trigger).getByText(/^Trace ·/)).toHaveTextContent(
        'Trace · 2 steps · 3 sources cited'
      )
      expect(screen.getByTestId('derivation-warning')).toHaveTextContent(
        plain(tEn('thinking.derivationWarning.open', { count: 1 }))
      )
      expect(trigger).toHaveAccessibleName(
        new RegExp(
          `^Done · Trace\u00A0· 2\\ssteps\u00A0· 3\\ssources cited · ${tEn('thinking.derivationWarning.open', { count: 1 })}$`
        )
      )
      // The dot never starts a line: a no-break space holds it to the word before.
      expect(within(trigger).getByText(/^Trace/).textContent).toMatch(/^Trace\u00A0· 2\ssteps\u00A0· /)
    })

    test('a failed call outranks an open point', () => {
      render(
        <ChatThinking
          steps={foldScene(failedCallScene())}
          citations={failedCallCitations()}
          isThinking={false}
        />
      )
      expect(screen.getByTestId('derivation-warning')).toHaveTextContent('1 call failed')
    })

    test('no warning while the turn works', () => {
      render(<ChatThinking steps={foldScene(failedCallScene())} isThinking />)
      expect(screen.queryByTestId('derivation-warning')).not.toBeInTheDocument()
    })

    test('a turn that looked nothing up is one line that opens nothing', () => {
      render(
        <ChatThinking
          steps={[]}
          isThinking={false}
          userQuestion="Was ist eine Brandwand?"
          answerConfidence="medium"
        />
      )
      expect(screen.getByTestId('derivation-no-research')).toHaveTextContent(
        'Answered without researchGeneral expertise, no source cited'
      )
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    test('a turn of one call is that call: no graph', () => {
      render(
        <ChatThinking
          steps={foldScene(singleReadScene())}
          citations={singleReadCitations()}
          isThinking={false}
        />
      )
      const single = screen.getByTestId('derivation-single')
      expect(single).toHaveTextContent('Read: Brandschutzkonzeptp. 7 · cited 1')
      // The one control is the answer's marker for [1]; nothing opens a panel.
      expect(within(single).getByRole('button')).toHaveAttribute('data-citation-marker', '1')
      expect(document.querySelector('[data-derivation-trigger]')).not.toBeInTheDocument()
      expect(screen.queryByTestId('reasoning-flow')).not.toBeInTheDocument()
    })

    test('a turn whose calls are rows has no tool chips beside them', () => {
      render(<ChatThinking steps={foldScene(mockupScene())} isThinking defaultOpen />)
      expect(screen.queryByText('Ran:')).not.toBeInTheDocument()
    })
  })

  describe('header label roll', () => {
    /** One source step naming `n` distinct OIB documents: `n` source cards. */
    const withSources = (n: number) => [
      oibSources(Array.from({ length: n }, (_, i) => ({ name: `OIB-RL_${i + 1}.pdf`, detail: 'p.1' }))),
    ]
    const labels = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('[data-derivation-label]'))
    const counts = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('[data-derivation-count]')).map((n) => n.textContent)

    test('a new count keeps the words and rolls only the digits', async () => {
      // At the settle the count often moves (9 → 11 Quellen). Re-keying the
      // whole label for it blanked the header for a few frames at the peak.
      const { container, rerender } = render(
        <ChatThinking steps={withSources(2)} isThinking answering />
      )
      const words = labels(container)[0]
      expect(words).toHaveTextContent('Trace · 2 sources')

      rerender(<ChatThinking steps={withSources(3)} isThinking={false} answering />)

      expect(labels(container)).toEqual([words])
      // Both numbers during the roll: the old one leaving, the new one arriving.
      expect(counts(container)).toEqual(expect.arrayContaining(['2', '3']))
      await waitFor(() => expect(counts(container)).toEqual(['3']))
      expect(labels(container)).toEqual([words])
      expect(words).toHaveTextContent('Trace · 3 sources')
    })

    test('the plural is worded for one source and for several', () => {
      const { container, rerender } = render(<ChatThinking steps={withSources(1)} isThinking={false} />)
      expect(labels(container)[0]).toHaveTextContent(/^Trace · 1 source$/)

      rerender(<ChatThinking steps={withSources(2)} isThinking={false} />)
      expect(labels(container).at(-1)).toHaveTextContent(/^Trace · 2 sources$/)
    })

    test('a new label rolls in while the old one leaves: never zero labels', async () => {
      // The fold: the activity phrase gives way to the summary. With `wait`
      // the header showed no label between the two.
      const { container, rerender } = render(<ChatThinking steps={withSources(2)} isThinking />)
      expect(labels(container)).toHaveLength(1)
      expect(labels(container)[0]).toHaveTextContent('Working on a response …')

      rerender(<ChatThinking steps={withSources(2)} isThinking answering />)

      const during = labels(container).map((n) => n.textContent)
      expect(during).toHaveLength(2)
      expect(during.map(plain)).toEqual(
        expect.arrayContaining(['Working on a response …', 'Trace · 2 sources'])
      )
      await waitFor(() => expect(labels(container)).toHaveLength(1))
      expect(labels(container)[0]).toHaveTextContent('Trace · 2 sources')
    })

    test('the shimmer runs on the live phrase only', () => {
      const { container, rerender } = render(<ChatThinking steps={withSources(2)} isThinking />)
      expect(labels(container)[0].querySelector('.animate-shimmer-window')).not.toBeNull()

      rerender(<ChatThinking steps={withSources(2)} isThinking={false} />)
      const summary = labels(container).find((n) => plain(n.textContent) === 'Trace · 2 sources')
      expect(summary?.querySelector('.animate-shimmer-window')).toBeNull()
    })

    test('reduced motion: the label and the count change at once', async () => {
      motionPref.reduced = true
      const { container, rerender } = render(<ChatThinking steps={withSources(2)} isThinking />)

      rerender(<ChatThinking steps={withSources(3)} isThinking={false} />)

      // Instant transitions still leave the exit to a frame; it is gone on the next.
      await waitFor(() => expect(labels(container)).toHaveLength(1), { timeout: 100 })
      expect(labels(container)[0]).toHaveTextContent('Trace · 3 sources')
      expect(counts(container)).toEqual(['3'])
    })
  })
})
