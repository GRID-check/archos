/**
 * Whether a viewer action moves the asker's viewer (ADR-0144): held until the
 * answer is there, then one place moves when the person allows it and is not
 * typing; offered otherwise; and an undo says only what it did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_VIEWER_PASSAGE_CHARS } from '@/adapters/api/wire-v2'
import * as analytics from '@/lib/analytics/posthog'
import {
  TYPING_WAIT_MS,
  VIEWER_ACTIONS_AUTO_KEY,
  citationViewerAction,
  dropViewerActions,
  newViewerActions,
  noteTypedAt,
  noteViewerRoom,
  proposeViewerAction,
  registerViewerActionRunner,
  releaseViewerActions,
  resetViewerActions,
  setViewerActionsAuto,
  showViewerAction,
  undoViewerAction,
  useViewerActionStore,
  viewerActionsAuto,
  viewerActionsOf,
  viewerClientTools,
  type ViewerActionCall,
  type ViewerActionName,
  type ViewerActionOutcome,
} from './viewer-actions'

const call = (name: ViewerActionName, id = `va_${name}`): ViewerActionCall => ({
  tool_call_id: id,
  tool_call_name: name,
  args: {
    document_id: 'doc-1',
    document_name: 'Baubeschreibung.pdf',
    page: 4,
    passage: name === 'highlight_passage' ? 'Fluchtwege 1,20 m' : null,
    region: null,
    against_document_id: name === 'compare_revisions' ? 'doc-0' : null,
    against_document_name: null,
    element: null,
  },
})

const entry = (id: string) => useViewerActionStore.getState().entries[id]

let outcome: ViewerActionOutcome
const undo = vi.fn(() => true)
const run = vi.fn(async (_call: ViewerActionCall) => outcome)
let room = true

/** One answer's actions, arriving while its turn runs, then released by its answer. */
const answered = async (answerId: string, ...calls: ViewerActionCall[]) => {
  for (const proposed of calls) proposeViewerAction(answerId, proposed)
  await releaseViewerActions(answerId)
}

beforeEach(() => {
  resetViewerActions()
  localStorage.clear()
  outcome = { outcome: 'shown', where: 'beside', undo }
  undo.mockReset()
  undo.mockReturnValue(true)
  run.mockClear()
  room = true
  registerViewerActionRunner({ hasRoom: () => room, run })
  setViewerActionsAuto(true)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetViewerActions()
})

describe('nothing moves before the answer is there', () => {
  it('holds an action while its turn runs, and the row shows nothing yet', () => {
    proposeViewerAction('answer-1', call('highlight_passage'))

    expect(run).not.toHaveBeenCalled()
    expect(entry('va_highlight_passage')?.status).toBe('held')
    expect(viewerActionsOf(useViewerActionStore.getState(), 'answer-1')).toEqual([])
  })

  it('moves the viewer once the answer releases it, and says so, with the way back', async () => {
    await answered('answer-1', call('highlight_passage'))

    expect(run).toHaveBeenCalledOnce()
    expect(entry('va_highlight_passage')).toMatchObject({ status: 'shown', where: 'beside', answerId: 'answer-1' })
    undoViewerAction('va_highlight_passage')
    expect(undo).toHaveBeenCalledOnce()
    expect(entry('va_highlight_passage')?.status).toBe('undone')
  })

  it('drops what a turn held when it ends without an answer', () => {
    proposeViewerAction('answer-1', call('open_document'))

    dropViewerActions('answer-1')

    expect(run).not.toHaveBeenCalled()
    expect(entry('va_open_document')).toBeUndefined()
    expect(useViewerActionStore.getState().byAnswer['answer-1']).toBeUndefined()
  })

  it('moves one place per answer and offers the others', async () => {
    await answered('answer-1', call('open_document', 'va_1'), call('highlight_passage', 'va_2'))

    expect(run).toHaveBeenCalledOnce()
    expect(entry('va_1')?.status).toBe('shown')
    expect(entry('va_2')).toMatchObject({ status: 'offered', reason: 'another' })
  })

  it('arrives once: the same call again is the same action', async () => {
    proposeViewerAction('answer-1', call('open_document'))
    await answered('answer-1', call('open_document'))

    expect(run).toHaveBeenCalledOnce()
    expect(useViewerActionStore.getState().byAnswer['answer-1']).toEqual(['va_open_document'])
  })
})

describe('what an undo says', () => {
  it('says „Zurückgenommen“ only when it put something back', async () => {
    undo.mockReturnValue(false)
    await answered('answer-1', call('open_document'))

    undoViewerAction('va_open_document')

    expect(entry('va_open_document')?.status).toBe('kept')
  })
})

describe('when it moves nothing', () => {
  it('records a refusal and its reason, and moves nothing', async () => {
    outcome = { outcome: 'refused', reason: 'unavailable' }

    await answered('answer-1', call('open_document'))

    expect(entry('va_open_document')).toMatchObject({ status: 'refused', refusal: 'unavailable' })
  })

  it('offers it when the person turned it off, and runs it on their press', async () => {
    setViewerActionsAuto(false)

    await answered('answer-1', call('open_document'))
    expect(run).not.toHaveBeenCalled()
    expect(entry('va_open_document')).toMatchObject({ status: 'offered', reason: 'off' })

    await showViewerAction('va_open_document')
    expect(entry('va_open_document')?.status).toBe('shown')
  })

  it.each(['compare_revisions', 'focus_ifc_element'] as const)('offers %s: it covers or leaves the chat', async (name) => {
    await answered('answer-1', call(name))

    expect(run).not.toHaveBeenCalled()
    expect(entry(`va_${name}`)).toMatchObject({ status: 'offered', reason: 'leaves' })
  })

  it('waits while the person types, and offers the place when no pause comes', async () => {
    vi.useFakeTimers()
    const typing = setInterval(() => noteTypedAt(Date.now()), 200)
    noteTypedAt(Date.now())

    const released = answered('answer-1', call('open_document'))
    await vi.advanceTimersByTimeAsync(TYPING_WAIT_MS + 500)
    await released
    clearInterval(typing)

    expect(run).not.toHaveBeenCalled()
    expect(entry('va_open_document')).toMatchObject({ status: 'offered', reason: 'typing' })
  })

  it('runs once the person paused', async () => {
    vi.useFakeTimers()
    noteTypedAt(Date.now())

    const released = answered('answer-1', call('open_document'))
    await vi.advanceTimersByTimeAsync(2000)
    await released

    expect(run).toHaveBeenCalledOnce()
  })

  it('offers it when there is no room beside the chat', async () => {
    room = false

    await answered('answer-1', call('open_document'))

    expect(entry('va_open_document')).toMatchObject({ status: 'offered', reason: 'noRoom' })
  })
})

describe('what the page declares', () => {
  it('declares the viewer tool only while a viewer has room beside the chat', () => {
    expect(viewerClientTools()).toEqual(['show_in_viewer'])
    noteViewerRoom(false)
    expect(viewerClientTools()).toEqual([])
    noteViewerRoom(true)
    expect(viewerClientTools()).toEqual(['show_in_viewer'])
    resetViewerActions()
    noteViewerRoom(true)
    expect(viewerClientTools()).toEqual([])
  })

  it('passes over an action this bundle does not know', () => {
    const sixth = { ...call('open_document'), tool_call_name: 'follow_cursor' } as unknown as ViewerActionCall
    expect(newViewerActions(undefined, [sixth, call('open_document')]).map((c) => c.tool_call_name)).toEqual(['open_document'])
  })
})

describe('the person’s choice', () => {
  it('is kept in this browser', () => {
    setViewerActionsAuto(false)
    expect(localStorage.getItem(VIEWER_ACTIONS_AUTO_KEY)).toBe('off')
  })

  it('starts off when the system asks for reduced motion', () => {
    resetViewerActions()
    localStorage.clear()
    const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)

    expect(viewerActionsAuto()).toBe(false)
    matchMedia.mockRestore()
  })
})

describe('what is measured', () => {
  it('records each outcome and the switch by kind, never by name or passage', async () => {
    const capture = vi.spyOn(analytics, 'capturePosthog').mockImplementation(() => {})

    await answered('answer-1', call('highlight_passage'))
    undoViewerAction('va_highlight_passage')
    setViewerActionsAuto(false)

    expect(capture.mock.calls).toEqual([
      ['viewer_action_outcome', { action: 'highlight_passage', outcome: 'shown', reason: null }],
      ['viewer_action_outcome', { action: 'highlight_passage', outcome: 'undone', reason: null }],
      ['viewer_actions_auto_changed', { on: false }],
    ])
    expect(JSON.stringify(capture.mock.calls)).not.toContain('Baubeschreibung')
  })
})

describe('the fold’s actions and a citation’s', () => {
  it('hands on only what a later fold added', () => {
    const first = [call('open_document')]
    expect(newViewerActions(undefined, first)).toEqual(first)
    expect(newViewerActions(first, first)).toEqual([])
    expect(newViewerActions(first, [...first, call('highlight_region')]).map((c) => c.tool_call_name)).toEqual([
      'highlight_region',
    ])
  })

  it('opens a citation at its box, else its words (as long as the wire allows), else its page', () => {
    const cited = { documentId: 'doc-1', documentName: 'Grundriss EG.pdf', page: 2 }
    expect(citationViewerAction({ ...cited, box: [0.1, 0.2, 0.4, 0.5] })).toMatchObject({
      tool_call_name: 'highlight_region',
      args: { page: 2, region: [0.1, 0.2, expect.closeTo(0.3), expect.closeTo(0.3)] },
    })
    expect(citationViewerAction({ ...cited, passage: ' Fluchtweg ' })).toMatchObject({
      tool_call_name: 'highlight_passage',
      args: { passage: 'Fluchtweg' },
    })
    expect(citationViewerAction({ ...cited, passage: 'a'.repeat(1000) }).args.passage).toHaveLength(MAX_VIEWER_PASSAGE_CHARS)
    expect(citationViewerAction(cited).tool_call_name).toBe('open_document')
  })
})
