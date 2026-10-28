/**
 * The inline citation, driven by a finger.
 *
 * `CitationMarker.spec.tsx` is the mouse and keyboard contract. This is what a
 * phone adds: the pinned peek is a bottom sheet with its own close and the open
 * action as one button, a source with no file says so in a sentence rather than
 * as a dead action, and a tap that misses the 22px pill by a thumb's width still
 * opens the nearest one.
 */

import { fireEvent, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { AgentResponse } from './AgentResponse'
import { resetSourcePreviewIndexCache } from './source-preview/source-preview-index'
import type { CitationSource } from '../types'
import { popoverMounts, resetPopoverMounts } from '@/test-utils/popover-mounts'

vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/test-utils/popover-mounts')).countPopoverMounts(await importOriginal())
)

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { showTechnicalReasoning: false }
    return selector ? selector(state) : state
  }),
}))

vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { projectId: null, currentConversation: null, patchConversationMessage: vi.fn() }
    return selector ? selector(state) : state
  }),
}))

vi.mock('@/adapters/api', () => ({ cancelJob: vi.fn() }))
vi.mock('@/adapters/auth', () => ({ useAuth: () => ({ accessToken: null }) }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/app/chat',
}))

const OIB = 'oib-rl_2.1_ausgabe_mai_2023.pdf'
const at = new Date('2026-07-28T12:00:00Z')

const jsonResponse = (data: unknown) => ({ ok: true, json: async () => data })

/** The corpus listing: the file is there (or, with `[]`, it is not). */
const fetchWith = (files: { fileName: string; state: string }[]) =>
  vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(
      String(input) === '/api/knowledge-base' ? jsonResponse({ files }) : jsonResponse({ documents: [] })
    )
  )

const citation = (page: number, number: number, passage?: string): CitationSource => ({
  id: `c${number}`,
  content: passage ? `[KB] ${OIB}, p.${page}\n${passage}` : `[KB] ${OIB}, p.${page}`,
  citationKey: `${OIB}, p.${page}`,
  fileName: OIB,
  collection: 'oib_knowledge',
  title: 'OIB-Richtlinie 2.1, Ausgabe Mai 2023',
  origin: 'kb',
  kind: 'building_law',
  lane: 'building_law_oib',
  laneLabel: 'OIB-Richtlinie',
  page,
  number,
  isCited: true,
  timestamp: at,
})

const answer = [
  'Zwei Fluchtwege sind erforderlich [1], die Rauchableitung folgt daraus [2].',
  '',
  '## Quellen',
  `- [1] [KB] ${OIB}, p.5`,
  `- [2] [KB] ${OIB}, p.18`,
].join('\n')

const renderAnswer = () =>
  render(
    <AgentResponse
      content={answer}
      messageId="m1"
      citations={[citation(5, 1, 'Garagen sind mechanisch zu entlüften.'), citation(18, 2)]}
      routingDecision="deep"
    />
  )

/** A device whose primary pointer is a finger (or, with `false`, a mouse). */
const stubPointer = (coarse: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: coarse && query === '(pointer: coarse)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )

describe('a citation marker under a finger', () => {
  beforeEach(() => {
    resetSourcePreviewIndexCache()
    resetPopoverMounts()
    vi.stubGlobal('fetch', fetchWith([{ fileName: OIB, state: 'ingested' }]))
    stubPointer(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('pins its peek as a bottom sheet with a close and one open action', async () => {
    const user = userEvent.setup()
    renderAnswer()

    await user.click(screen.getByRole('button', { name: /Source 1: OIB-Richtlinie 2\.1/i }))

    const sheet = await screen.findByRole('dialog')
    expect(sheet).toHaveAttribute('data-citation-sheet')
    // It names the source it belongs to: the sentence is behind the scrim.
    expect(within(sheet).getByText('Source 1')).toBeInTheDocument()
    expect(within(sheet).getByText('Garagen sind mechanisch zu entlüften.')).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeInTheDocument()
    // The passage is one press away, as the primary action.
    const open = await within(sheet).findByRole('button', { name: /Open at this passage/i })
    expect(open).toHaveAttribute('data-citation-open')
    // No popover was mounted for it: one presentation, not two.
    expect(popoverMounts.total).toBe(0)
  })

  test('closes on its own close button and stays closed', async () => {
    const user = userEvent.setup()
    renderAnswer()
    const marker = screen.getByRole('button', { name: /Source 1: OIB-Richtlinie 2\.1/i })

    await user.click(marker)
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close' }))

    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Focus went back to the marker, whose focus handler opens a peek: it must
    // not read the return as a reason to open.
    expect(document.activeElement).toBe(marker)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('says a source has no file in a sentence, not as a control', async () => {
    vi.stubGlobal('fetch', fetchWith([]))
    resetSourcePreviewIndexCache()
    const user = userEvent.setup()
    renderAnswer()

    const m = screen.getByRole('button', { name: /Source 1: OIB-Richtlinie 2\.1/i })
    await user.click(m)

    const sheet = await screen.findByRole('dialog')
    const note = await within(sheet).findByText('No file for this source is available in Piloti.')
    expect(note.tagName).toBe('P')
    expect(within(sheet).queryByRole('button', { name: /Open at this passage/i })).toBeNull()
  })

  test('a tap beside a marker, on nothing pressable, opens the nearest one', async () => {
    renderAnswer()
    const [first, second] = ['Source 1', 'Source 2'].map((label) =>
      screen.getByRole('button', { name: new RegExp(`${label}: OIB`, 'i') })
    )
    // jsdom has no layout: two pills on one line, 30px apart.
    first!.getBoundingClientRect = () => ({ left: 100, right: 122, top: 50, bottom: 76 }) as DOMRect
    second!.getBoundingClientRect = () => ({ left: 152, right: 174, top: 50, bottom: 76 }) as DOMRect
    const prose = screen.getByText(/Zwei Fluchtwege sind erforderlich/)

    // 8px right of the first pill, 22px left of the second: the first.
    fireEvent.click(prose, { clientX: 130, clientY: 60 })
    expect(await screen.findByText('Source 1')).toBeInTheDocument()
  })

  test('a tap too far from any marker opens nothing', () => {
    renderAnswer()
    const first = screen.getByRole('button', { name: /Source 1: OIB/i })
    first.getBoundingClientRect = () => ({ left: 100, right: 122, top: 50, bottom: 76 }) as DOMRect
    const prose = screen.getByText(/Zwei Fluchtwege sind erforderlich/)

    fireEvent.click(prose, { clientX: 300, clientY: 60 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('a mouse gets no catchment beyond the pill, and the popover rather than the sheet', async () => {
    stubPointer(false)
    renderAnswer()
    const first = screen.getByRole('button', { name: /Source 1: OIB/i })
    first.getBoundingClientRect = () => ({ left: 100, right: 122, top: 50, bottom: 76 }) as DOMRect
    fireEvent.click(screen.getByText(/Zwei Fluchtwege sind erforderlich/), { clientX: 130, clientY: 60 })
    expect(screen.queryByRole('dialog')).toBeNull()

    await userEvent.setup().click(first)
    expect(await screen.findByRole('dialog')).not.toHaveAttribute('data-citation-sheet')
  })
})
