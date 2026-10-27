/**
 * The chat's row for Piloti's viewer actions (ADR-0144): announced once the
 * answer is there, undoable, offered when it did not move, neutral when the
 * document is not available, and the person's switch beside it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@/test-utils'
import { I18nProvider } from '@/i18n'
import {
  proposeViewerAction,
  registerViewerActionRunner,
  releaseViewerActions,
  resetViewerActions,
  setViewerActionsAuto,
  noteViewerLocation,
  showViewerAction,
  useViewerActionStore,
  type ViewerActionCall,
  type ViewerActionOutcome,
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
    element: name === 'focus_ifc_element' ? '1kTvQ9x8n5RfBW2$hK0aZq' : null,
  },
})

const undo = vi.fn(() => true)
let outcome: ViewerActionOutcome

beforeEach(() => {
  resetViewerActions()
  localStorage.clear()
  undo.mockReset()
  undo.mockReturnValue(true)
  outcome = { outcome: 'shown', where: 'beside', undo }
  registerViewerActionRunner({ hasRoom: () => true, run: async () => outcome })
})

const answered = async (proposed: ViewerActionCall) => {
  await act(async () => {
    proposeViewerAction('answer-1', proposed)
    await releaseViewerActions('answer-1')
  })
}

// German, as the person reads it: the copy is what these tests are about.
const draw = () =>
  render(
    <I18nProvider initialLocale="de" fixedLocale>
      <ViewerActionRow messageId="answer-1" />
    </I18nProvider>
  )

describe('ViewerActionRow', () => {
  it('draws nothing for an answer that proposed no place', () => {
    const { container } = draw()
    expect(container.querySelector('[data-testid="viewer-action-row"]')).toBeNull()
  })

  it('says a place waits for the answer while the turn runs, and opens it on „Anzeigen“', async () => {
    setViewerActionsAuto(true)
    proposeViewerAction('answer-1', call('open_document', 'va_0'))
    draw()

    expect(screen.getByTestId('viewer-action')).toHaveAttribute('data-status', 'held')
    expect(screen.getByTestId('viewer-action-status')).toHaveTextContent('Wartet auf die fertige Antwort')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /anzeigen/i }))
    })
    expect(useViewerActionStore.getState().entries.va_0?.status).toBe('shown')
    expect(screen.getByRole('button', { name: /zurücknehmen/i })).toBeInTheDocument()
  })

  it('says what moved and puts it back on „Zurücknehmen“', async () => {
    setViewerActionsAuto(true)
    await answered(call('highlight_passage', 'va_1'))
    draw()

    expect(screen.getByRole('region')).toHaveTextContent('Baubeschreibung.pdf')
    fireEvent.click(screen.getByRole('button', { name: /zurücknehmen/i }))
    expect(undo).toHaveBeenCalledOnce()
    expect(useViewerActionStore.getState().entries.va_1?.status).toBe('undone')
    expect(screen.getByTestId('viewer-action-status')).toHaveTextContent('Zurückgenommen')
  })

  it('does not claim it put the viewer back when the person had changed it', async () => {
    setViewerActionsAuto(true)
    undo.mockReturnValue(false)
    await answered(call('open_document', 'va_1'))
    draw()

    fireEvent.click(screen.getByRole('button', { name: /zurücknehmen/i }))

    expect(screen.getByTestId('viewer-action-status')).not.toHaveTextContent('Zurückgenommen')
    expect(screen.getByTestId('viewer-action-status')).toHaveTextContent('inzwischen geändert')
  })

  it('says only that a refused document is not available, never that it exists', async () => {
    setViewerActionsAuto(true)
    outcome = { outcome: 'refused', reason: 'unavailable' }
    await answered(call('open_document', 'va_1'))
    draw()

    expect(screen.getByTestId('viewer-action-status')).toHaveTextContent('Nicht geöffnet: Dokument nicht verfügbar')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says the model view would open instead of the chat', async () => {
    await answered(call('focus_ifc_element', 'va_1'))
    draw()
    expect(screen.getByTestId('viewer-action-status')).toHaveTextContent('Öffnet die Modellansicht')
  })

  it('offers the place when it is off, and the switch turns it back on', async () => {
    setViewerActionsAuto(false)
    await answered(call('open_document', 'va_2'))
    draw()

    const row = screen.getByTestId('viewer-action')
    expect(row).toHaveAttribute('data-status', 'offered')
    fireEvent.click(screen.getByRole('switch'))
    expect(useViewerActionStore.getState().auto).toBe(true)
  })

  it('announces only the status text, not the controls', async () => {
    setViewerActionsAuto(true)
    await answered(call('open_document', 'va_1'))
    const { container } = draw()

    const live = container.querySelectorAll('[aria-live]')
    expect(live).toHaveLength(1)
    expect(live[0]).toHaveAttribute('data-testid', 'viewer-action-status')
    expect(screen.getByRole('region')).not.toHaveAttribute('aria-live')
  })

  it('offers no „Zurücknehmen“ for a model view the person has left', async () => {
    outcome = { outcome: 'shown', where: 'model', undo, undoable: () => false }
    await act(async () => {
      proposeViewerAction('answer-1', call('focus_ifc_element', 'va_m'))
      await showViewerAction('va_m')
      noteViewerLocation()
    })
    draw()

    expect(screen.getByTestId('viewer-action-status')).toHaveTextContent('Modellansicht geöffnet')
    expect(screen.queryByRole('button', { name: /zurücknehmen/i })).toBeNull()
  })
})
