/**
 * The revision compare card (ADR-0128, V10): the same page of two Fassungen side by
 * side, the changes boxed on each, the change sentences below; pressing a side opens
 * that Fassung at the page with every box on it. pdf.js is the shared fake.
 */
import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { fakePdfjsRuntime, type FakePdfState } from '@/test-utils/pdfjs-fake'
import { revisionCompareCardSchema } from '@/shared/cards/generated'
import { RevisionCompareCard, changeRegions, sidePlace } from './RevisionCompareCard'

const state = vi.hoisted((): FakePdfState => ({ fail: false, pages: [], destroyed: 0 }))
vi.mock('@/features/knowledge/lib/pdfjs-runtime', () => fakePdfjsRuntime(state))

const OLDER = '00000000-0000-4000-8000-0000000000d1'
const NEWER = '00000000-0000-4000-8000-0000000000d2'
/** The card as it arrives: parsed by the generated schema, defaults filled in. */
const card = revisionCompareCardSchema.parse({
  older_id: OLDER,
  newer_id: NEWER,
  page: 2,
  changes: [
    { region: [0.6, 0.1, 0.2, 0.1], label: 'Plankopf: Index B statt A' },
    { region: [0.1, 0.5, 0.3, 0.2], label: 'Laufbreite 1,10 m statt 1,00 m' },
  ],
  summary: ['Plankopf: Index B statt A', 'Treppe breiter'],
})

let restore: () => void = () => undefined
beforeEach(() => {
  state.fail = false
  state.pages = [{ items: [] }, { items: [] }, { items: [] }]
})
afterEach(() => restore())

const props = { olderId: card.older_id, newerId: card.newer_id, page: card.page, changes: card.changes, summary: card.summary }

describe('RevisionCompareCard', () => {
  test('shows an older and a newer side, the page, and the change sentences', () => {
    render(<RevisionCompareCard {...props} />)
    const sides = screen.getAllByTestId('revision-compare-side')
    expect(sides.map((side) => side.getAttribute('data-side'))).toEqual(['older', 'newer'])
    expect(sides[0]).toHaveTextContent('Older Fassung')
    expect(sides[1]).toHaveTextContent('Newer Fassung')
    expect(screen.getByTestId('revision-compare-card')).toHaveTextContent('p. 2')
    const lines = within(screen.getByTestId('revision-compare-summary')).getAllByRole('listitem')
    expect(lines.map((line) => line.textContent)).toEqual(['Plankopf: Index B statt A', 'Treppe breiter'])
  })

  test('labels each side with its file name when the comparison named it, and with its role otherwise', () => {
    const { rerender } = render(<RevisionCompareCard {...props} olderName="Grundriss_A.pdf" newerName="Grundriss_B.pdf" />)
    const sides = screen.getAllByTestId('revision-compare-side')
    expect(sides[0]).toHaveTextContent('Grundriss_A.pdf')
    expect(sides[1]).toHaveTextContent('Grundriss_B.pdf')
    expect(sides[0]).not.toHaveTextContent('Older Fassung')
    expect(screen.getByRole('button', { name: 'Grundriss_A.pdf, p. 2: open with the changes' })).toBeInTheDocument()

    rerender(<RevisionCompareCard {...props} olderName="Grundriss_A.pdf" />)
    const mixed = screen.getAllByTestId('revision-compare-side')
    expect(mixed[0]).toHaveTextContent('Grundriss_A.pdf')
    expect(mixed[1]).toHaveTextContent('Newer Fassung')
  })

  test('a change is a corner pair for the viewer, and each side is an address of its own document', () => {
    expect(changeRegions(card.changes)).toEqual([
      { box: [0.6, 0.1, 0.8, 0.2] },
      { box: [0.1, 0.5, 0.4, 0.7] },
    ])
    expect(sidePlace(OLDER, 'Older Fassung', 2)).toEqual({
      document: { id: OLDER, name: 'Older Fassung', shelf: 'stored' },
      page: 2,
      frame: 'page',
      region: null,
    })
  })

  test('marks every change on both pages once they are drawn', async () => {
    restore = installLayoutObservers({ frameWidth: 320 })
    render(<RevisionCompareCard {...props} />)
    await waitFor(() => expect(screen.getAllByTestId('region-mark')).toHaveLength(4))
    for (const side of screen.getAllByTestId('revision-compare-side')) {
      expect(within(side).getAllByTestId('region-mark')).toHaveLength(2)
    }
  })

  test('opens a side at the page with every box on it, by keyboard', async () => {
    restore = installLayoutObservers({ frameWidth: 320 })
    const user = userEvent.setup()
    render(<RevisionCompareCard {...props} />)
    await waitFor(() => expect(screen.getAllByTestId('region-mark')).toHaveLength(4))

    screen.getByRole('button', { name: 'Older Fassung, p. 2: open with the changes' }).focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByTestId('pdf-viewer-dialog')
    await waitFor(() => expect(within(dialog).getAllByTestId('region-mark')).toHaveLength(2))
  })

  test('without a change, both pages are still shown, unmarked, with the sentence', () => {
    render(<RevisionCompareCard {...props} changes={[]} summary={['keine sichtbare Änderung']} />)
    expect(screen.getAllByTestId('revision-compare-side')).toHaveLength(2)
    expect(screen.queryByTestId('region-mark')).toBeNull()
    expect(screen.getByTestId('revision-compare-summary')).toHaveTextContent('keine sichtbare Änderung')
  })

  test('the schema refuses image bytes', () => {
    expect(() => revisionCompareCardSchema.parse({ ...card, summary: ['data:image/png;base64,AAAA'] })).toThrow()
  })
})
