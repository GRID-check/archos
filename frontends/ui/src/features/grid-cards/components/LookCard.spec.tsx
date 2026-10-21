/**
 * The look card (ADR-0128): per place a thumbnail with the box marked, the
 * page and the place in words, what Piloti looked for and, marked as such,
 * what it read there; pressing a place, with the mouse or the keyboard, opens
 * the document at that page with the box on it. pdf.js is the shared fake.
 */
import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { fakePdfjsRuntime, type FakePdfState } from '@/test-utils/pdfjs-fake'
import { lookCardSchema } from '@/shared/cards/generated'
import { LookCard, lookItemColor, lookItemPlace } from './LookCard'

const state = vi.hoisted((): FakePdfState => ({ fail: false, pages: [], destroyed: 0 }))
vi.mock('@/features/knowledge/lib/pdfjs-runtime', () => fakePdfjsRuntime(state))

const DOCUMENT = { id: '00000000-0000-4000-8000-0000000000c1', name: 'Grundriss EG.pdf', shelf: 'stored' as const }
/** Items as the card arrives: parsed by the generated schema, defaults filled in. */
const parsed = (items: Record<string, unknown>[]) => lookCardSchema.parse({ document: DOCUMENT, items }).items
const ITEMS = parsed([
  {
    origin: 'look' as const,
    page: 2,
    frame: 'page' as const,
    scope: 'region' as const,
    region: [0.62, 0.04, 0.34, 0.22],
    where: 'oben rechts',
    question: 'Maßstab im Plankopf?',
    reading: 'M 1:100',
  },
  {
    origin: 'reference' as const,
    page: 2,
    frame: 'page' as const,
    scope: 'region' as const,
    region: [0.58, 0.34, 0.14, 0.22],
    where: 'in der Seitenmitte',
    label: 'Laufbreite 1,10 m',
  },
])

let restore: () => void = () => undefined
beforeEach(() => {
  state.fail = false
  state.pages = [{ items: [] }, { items: [] }, { items: [] }]
})
afterEach(() => restore())

describe('LookCard', () => {
  test('names each place, what Piloti looked for, and what it read, marked as a reading', () => {
    render(<LookCard document={DOCUMENT} items={ITEMS} />)
    const card = screen.getByTestId('look-card')
    expect(within(card).getByText('Grundriss EG.pdf')).toBeInTheDocument()
    const [look, reference] = screen.getAllByTestId('look-item')
    expect(look).toHaveTextContent('p. 2 · oben rechts')
    expect(look).toHaveTextContent('Maßstab im Plankopf?')
    expect(within(look).getByTestId('look-reading')).toHaveTextContent('Read: M 1:100')
    expect(within(look).getByTestId('look-reading')).toHaveAttribute('title', 'Read off the page by Piloti, not measured.')
    expect(screen.getByTestId('look-reading-note')).toHaveTextContent('not measured')
    expect(reference).toHaveAttribute('data-origin', 'reference')
    expect(reference).toHaveTextContent('Shown on p. 2 · in der Seitenmitte')
    expect(reference).toHaveTextContent('Laufbreite 1,10 m')
    expect(within(reference).queryByTestId('look-reading')).toBeNull()
  })

  test('without a reading, no note about readings', () => {
    render(<LookCard document={DOCUMENT} items={parsed([{ page: 1, scope: 'overview' }])} />)
    expect(screen.getByTestId('look-item')).toHaveTextContent('p. 1 · whole page')
    expect(screen.queryByTestId('look-reading-note')).toBeNull()
  })

  test('an item is an address: the place, its tint, a reference’s label on its box', () => {
    expect(lookItemPlace(DOCUMENT, ITEMS[1]!)).toEqual({
      document: { id: DOCUMENT.id, name: 'Grundriss EG.pdf', shelf: 'stored' },
      page: 2,
      frame: 'page',
      region: [0.58, 0.34, 0.14, 0.22],
      point: null,
      imageIndex: null,
      revisionId: null,
      label: 'Laufbreite 1,10 m',
    })
    expect(lookItemColor('base', 'look')).toBe('var(--source-law)')
    expect(lookItemColor('stored', 'look')).toBe('var(--source-project)')
    expect(lookItemColor('stored', 'reference')).toBe('var(--paper-ink)')
  })

  test('draws each place on screen and opens the document at it, with the box, by keyboard', async () => {
    restore = installLayoutObservers({ frameWidth: 320 })
    const user = userEvent.setup()
    render(<LookCard document={DOCUMENT} items={ITEMS} />)
    await waitFor(() => expect(screen.getAllByTestId('region-mark')).toHaveLength(2))

    const [first] = screen.getAllByRole('button', { name: 'Open Grundriss EG.pdf at p. 2' })
    first!.focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByTestId('pdf-viewer-dialog')
    expect(within(dialog).getByText('Grundriss EG.pdf')).toBeInTheDocument()
    await waitFor(() => expect(within(dialog).getAllByTestId('region-mark').length).toBeGreaterThan(0))
  })
})
