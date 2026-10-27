/**
 * The chat's row for Piloti's viewer actions (ADR-0144): announced, undoable,
 * offered when it did not move, and the person's switch beside it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@/test-utils'
import {
  proposeViewerAction,
  registerViewerActionRunner,
  resetViewerActions,
  setViewerActionsAuto,
  useViewerActionStore,
  type ViewerActionCall,
} from '../lib/viewer-actions'
import { ViewerActionRow } from './ViewerActionRow'

const call = (name: ViewerActionCall['tool_call_name'], id: string): ViewerActionCall => ({
  tool_call_id: id,
  tool_call_name: name,
  args: {
    document_id: 'doc-1',
    document_name: 'Baubeschreibung.pdf',
    page: 4,
    passage: 'Fluchtwege 1,20 m',
    region: null,
    against_document_id: null,
    against_document_name: null,
    element: null,
  },
})

const undo = vi.fn()

beforeEach(() => {
  resetViewerActions()
  localStorage.clear()
  undo.mockClear()
  registerViewerActionRunner({ hasRoom: () => true, run: async () => ({ outcome: 'shown', undo }) })
})

const draw = () =>
  render(<ViewerActionRow messageId="answer-1" />)

describe('ViewerActionRow', () => {
  it('draws nothing for an answer that moved no viewer', () => {
    const { container } = draw()
    expect(container.querySelector('[data-testid="viewer-action-row"]')).toBeNull()
  })

  it('says what moved and puts it back on „Zurück“', async () => {
    setViewerActionsAuto(true)
    await act(() => proposeViewerAction('answer-1', call('highlight_passage', 'va_1')))
    draw()

    expect(screen.getByRole('region')).toHaveTextContent('Baubeschreibung.pdf')
    fireEvent.click(screen.getByRole('button', { name: /Baubeschreibung\.pdf/ }))
    expect(undo).toHaveBeenCalledOnce()
    expect(useViewerActionStore.getState().entries.va_1?.status).toBe('undone')
  })

  it('offers the place when it is off, and the switch turns it back on', async () => {
    setViewerActionsAuto(false)
    await act(() => proposeViewerAction('answer-1', call('open_document', 'va_2')))
    draw()

    const row = screen.getByTestId('viewer-action')
    expect(row).toHaveAttribute('data-status', 'offered')
    fireEvent.click(screen.getByRole('switch'))
    expect(useViewerActionStore.getState().auto).toBe(true)
  })
})
