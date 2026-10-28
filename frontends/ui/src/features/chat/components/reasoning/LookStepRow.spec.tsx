/**
 * The Herleitung's look rows (ADR-0128), from wire steps folded the way the
 * app folds them: the row a `look` call draws („Betrachtet <document>, S.
 * <page>, <where>“) with a thumbnail, consecutive looks at one document as one
 * row, a click opens the document at the place. And the graph shows them under
 * itself.
 */
import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { de } from '@/i18n/dictionaries'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { fakePdfjsRuntime, type FakePdfState } from '@/test-utils/pdfjs-fake'
import { storedSteps } from '@/test-utils/wire-v2-steps'
import { lookStepGroups } from '../../lib/look-steps'
import { LookStepRows } from './LookStepRow'
import { ReasoningFlow } from './ReasoningFlow'

const state = vi.hoisted((): FakePdfState => ({ fail: false, pages: [{ items: [] }, { items: [] }], destroyed: 0 }))
vi.mock('@/features/knowledge/lib/pdfjs-runtime', () => fakePdfjsRuntime(state))

const look = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `look:${n}`,
  kind: 'look',
  document_name: 'Grundriss EG.pdf',
  document_id: '00000000-0000-4000-8000-0000000000c1',
  page: 2,
  region: [0.62, 0.04, 0.34, 0.22],
  where: 'oben rechts',
  question: 'Maßstab?',
  reading: 'M 1:100',
  ...extra,
})

let restore: () => void = () => undefined
afterEach(() => restore())

describe('lookStepGroups', () => {
  test('reads the folded address back, and folds consecutive looks at one document', () => {
    const groups = lookStepGroups(
      storedSteps([
        look(1),
        look(2, { region: null, where: null, page: 1 }),
        look(3, { document_name: 'Schnitt A-A.pdf', document_id: null, shelf: 'base' }),
      ])
    )
    expect(groups).toHaveLength(2)
    expect(groups[0]!.looks.map((item) => item.place.page)).toEqual([2, 1])
    expect(groups[0]!.looks[0]!.place).toMatchObject({
      document: { id: '00000000-0000-4000-8000-0000000000c1', name: 'Grundriss EG.pdf', shelf: 'stored' },
      frame: 'page',
      region: [0.62, 0.04, 0.34, 0.22],
    })
    expect(groups[0]!.looks[1]!.place.region).toBeNull()
    expect(groups[1]!.document).toEqual({ id: null, name: 'Schnitt A-A.pdf', shelf: 'base' })
  })

  test('a retrieval round between two looks at one document starts a new row', () => {
    const groups = lookStepGroups(
      storedSteps([
        look(1),
        { id: 'status:retrieval:1', kind: 'retrieval', round: 1, key: 'status.retrieval.withQuery', values: {} },
        look(2),
      ])
    )
    expect(groups).toHaveLength(2)
  })
})

describe('LookStepRows', () => {
  test('one look: the sentence, and a thumbnail that opens the document at the place', async () => {
    restore = installLayoutObservers({ frameWidth: 200 })
    const user = userEvent.setup()
    render(<LookStepRows steps={storedSteps([look(1)])} />)
    const row = within(screen.getByTestId('look-step-rows')).getByTestId('work-row')
    // The region comes German off the wire and reads in the reader's language.
    expect(row).toHaveTextContent('Looks at Grundriss EG.pdf, p. 2, top right')
    expect(row).toHaveTextContent('M 1:100')
    await waitFor(() => expect(within(row).getByTestId('region-mark')).toBeInTheDocument())

    await user.click(within(row).getByRole('button', { name: 'Open Grundriss EG.pdf at p. 2' }))
    const dialog = await screen.findByTestId('pdf-viewer-dialog')
    await waitFor(() => expect(within(dialog).getAllByTestId('region-mark').length).toBeGreaterThan(0))
  })

  test('several looks at one document: one row, a strip with each place named', () => {
    render(<LookStepRows steps={storedSteps([look(1), look(2, { region: null, where: null, page: 1 })])} />)
    const row = within(screen.getByTestId('look-step-rows')).getByTestId('work-row')
    expect(row).toHaveTextContent('Looks at Grundriss EG.pdf2 passages')
    expect(within(row).getAllByTestId('page-place-button')).toHaveLength(2)
    expect(row).toHaveTextContent('p. 2, top right')
    expect(row).toHaveTextContent('p. 1')
  })

  test('nothing for a turn that did not look', () => {
    render(<LookStepRows steps={storedSteps([{ id: 'status:retrieval:0', kind: 'retrieval', round: 0, key: 'status.retrieval.withQuery', values: {} }])} />)
    expect(screen.queryByTestId('look-step-rows')).toBeNull()
  })

  test('the Herleitung shows them under its graph', () => {
    render(<ReasoningFlow steps={storedSteps([look(1)])} userQuestion="Welcher Maßstab?" answerConfidence="high" />)
    expect(screen.getByTestId('look-step-rows')).toBeInTheDocument()
  })

  test('the German wording: the verb of a look row, and the region as the backend words it', () => {
    expect(de.chat.thinking.work.verb.look).toBe('Betrachtet')
    expect(de.chat.thinking.look.region.topRight).toBe('oben rechts')
  })
})
