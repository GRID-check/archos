/**
 * Piloti's viewer actions on the asker's own screen (ADR-0144).
 *
 * A `viewer_action` event is an AG-UI frontend tool call from an allow-list
 * (`wire_v2.ViewerActionName`): open a document at a page, mark a passage or a
 * box, compare two Fassungen, select a model element. It is a PROPOSAL of
 * navigation. This module decides whether the page carries it out, and keeps
 * what the chat shows about it: a row under the answer that says what moved and
 * offers „Zurück“, or offers „Anzeigen“ when it did not move.
 *
 * The rules a person can rely on:
 *  - Only the asker's live page runs one. The driver hands this module only
 *    the actions of turns it asked itself (`use-websocket-chat.ts`); a
 *    spectator, a replay after a reload and another tab never move anything.
 *  - The person can turn it off (`setViewerActionsAuto`); with reduced motion
 *    asked of the system it starts off. Off, the row offers the place instead.
 *  - It never moves the viewer while the person is typing. It waits for a pause
 *    and offers the place if none comes.
 *  - A comparison covers the conversation and a building model leaves it, so
 *    those two are always offered, never run on their own (`CONTEXT_CHANGING`).
 *  - What it may open is decided by the BFF in the person's session, by the
 *    runner (`features/documents/lib/viewer-action-runner.ts`); a document they
 *    may not see is refused and nothing moves.
 *
 * The runner lives with the documents feature and registers itself, the way
 * `canvas-bridge.ts` lets the review reach the chat: no import from here to there.
 */

import { create } from 'zustand'
import type { WireEvent } from '@/adapters/api/wire-v2'

/** One viewer action as the wire carries it: `tool_call_id`, `tool_call_name`, `args`. */
export type ViewerActionCall = Extract<WireEvent, { type: 'CUSTOM'; name: 'viewer_action' }>['value']
export type ViewerActionName = ViewerActionCall['tool_call_name']

/**
 * What became of one action. `shown`: the viewer moved and can go back.
 * `offered`: it did not move (`reason` says why) and the row offers it.
 * `refused`: the BFF will not open it for this person. `failed`: it could not be read.
 */
export type ViewerActionStatus = 'pending' | 'shown' | 'offered' | 'refused' | 'failed' | 'undone'
export type OfferReason = 'off' | 'typing' | 'leaves' | 'noRoom' | 'unavailable'

export interface ViewerActionEntry {
  call: ViewerActionCall
  answerId: string
  status: ViewerActionStatus
  reason?: OfferReason
}

export type ViewerActionOutcome = { outcome: 'shown'; undo: () => void } | { outcome: 'refused' } | { outcome: 'failed' }

export interface ViewerActionRunner {
  /** Whether the viewer has room beside the chat for an action now (not on a phone, not away from the chat). */
  hasRoom: () => boolean
  run: (call: ViewerActionCall) => Promise<ViewerActionOutcome>
}

/** How long after the last key the person counts as typing. */
export const TYPING_PAUSE_MS = 1500
/** How long an action waits for a pause before it is offered instead. */
export const TYPING_WAIT_MS = 8000
const TYPING_POLL_MS = 250
/** Where the person's choice is kept, per browser. */
export const VIEWER_ACTIONS_AUTO_KEY = 'grid.viewerActions.auto'

let runner: ViewerActionRunner | null = null
const undos = new Map<string, () => void>()

/** The viewer offers itself. Returns the withdrawal, which leaves a later registration alone. */
export const registerViewerActionRunner = (next: ViewerActionRunner): (() => void) => {
  runner = next
  return () => {
    if (runner === next) runner = null
  }
}

const readAuto = (): boolean => {
  try {
    const stored = window.localStorage.getItem(VIEWER_ACTIONS_AUTO_KEY)
    if (stored === 'on') return true
    if (stored === 'off') return false
  } catch {
    // Storage unavailable: fall through to the system's wish.
  }
  return typeof window.matchMedia !== 'function' || !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface ViewerActionState {
  entries: Record<string, ViewerActionEntry>
  byAnswer: Record<string, string[]>
  /** The answer whose row carries the switch: the latest one with an action, so the switch is drawn once. */
  latestAnswer: string | null
  /** Whether Piloti may move the viewer on its own. Read once on first use. */
  auto: boolean | null
}

export const useViewerActionStore = create<ViewerActionState>(() => ({ entries: {}, byAnswer: {}, latestAnswer: null, auto: null }))

const patch = (id: string, next: Partial<ViewerActionEntry>): void =>
  useViewerActionStore.setState((state) => {
    const entry = state.entries[id]
    return entry ? { entries: { ...state.entries, [id]: { ...entry, ...next } } } : state
  })

/** Whether Piloti moves the viewer on its own: the person's choice, else on unless they asked for reduced motion. */
export const autoPreference = (state: { auto: boolean | null }): boolean =>
  state.auto ?? (typeof window === 'undefined' ? false : readAuto())

export const viewerActionsAuto = (): boolean => autoPreference(useViewerActionStore.getState())

export const setViewerActionsAuto = (on: boolean): void => {
  useViewerActionStore.setState({ auto: on })
  try {
    window.localStorage.setItem(VIEWER_ACTIONS_AUTO_KEY, on ? 'on' : 'off')
  } catch {
    // Storage unavailable: the choice holds for this page.
  }
}

// --- typing -----------------------------------------------------------------

let lastTypedAt = Number.NEGATIVE_INFINITY
let listening = false

const editable = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
}

const listenForTyping = (): void => {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener(
    'keydown',
    (event) => {
      if (editable(event.target)) lastTypedAt = Date.now()
    },
    { capture: true }
  )
}

/** Whether the person typed into a field in the last {@link TYPING_PAUSE_MS}. */
export const isTyping = (now = Date.now()): boolean => now - lastTypedAt < TYPING_PAUSE_MS

const pause = async (): Promise<boolean> => {
  const until = Date.now() + TYPING_WAIT_MS
  while (isTyping()) {
    if (Date.now() >= until) return false
    await new Promise((resolve) => setTimeout(resolve, TYPING_POLL_MS))
  }
  return true
}

// --- running ----------------------------------------------------------------

const execute = async (id: string): Promise<void> => {
  const entry = useViewerActionStore.getState().entries[id]
  if (!entry || !runner) {
    patch(id, { status: 'offered', reason: 'unavailable' })
    return
  }
  const result = await runner.run(entry.call).catch((): ViewerActionOutcome => ({ outcome: 'failed' }))
  if (result.outcome === 'shown') {
    undos.set(id, result.undo)
    patch(id, { status: 'shown', reason: undefined })
    return
  }
  patch(id, { status: result.outcome })
}

/**
 * The actions that change the person's context rather than the viewer beside
 * the chat: a comparison covers the conversation, a model view leaves it. They
 * are offered and run only on a click (WCAG 3.2.5, change on request).
 */
export const CONTEXT_CHANGING: ReadonlySet<ViewerActionName> = new Set(['compare_revisions', 'focus_ifc_element'])

const offerReason = (call: ViewerActionCall): OfferReason | null => {
  if (CONTEXT_CHANGING.has(call.tool_call_name)) return 'leaves'
  if (!viewerActionsAuto()) return 'off'
  if (!runner) return 'unavailable'
  if (!runner.hasRoom()) return 'noRoom'
  return null
}

/**
 * A viewer action of a turn this page asked arrived. It is kept for the chat's
 * row and run when the person allows it and is not typing; otherwise offered.
 */
export const proposeViewerAction = async (answerId: string, call: ViewerActionCall): Promise<void> => {
  const id = call.tool_call_id
  if (useViewerActionStore.getState().entries[id]) return
  listenForTyping()
  useViewerActionStore.setState((state) => ({
    entries: { ...state.entries, [id]: { call, answerId, status: 'pending' } },
    byAnswer: { ...state.byAnswer, [answerId]: [...(state.byAnswer[answerId] ?? []), id] },
    latestAnswer: answerId,
  }))
  const reason = offerReason(call)
  if (reason) {
    patch(id, { status: 'offered', reason })
    return
  }
  if (!(await pause())) {
    patch(id, { status: 'offered', reason: 'typing' })
    return
  }
  await execute(id)
}

/** Whether a viewer beside the chat is mounted and has room now (a citation offers „Neben dem Chat öffnen“ only then). */
export const viewerBesideChat = (): boolean => runner?.hasRoom() ?? false

/**
 * The person asked for a place themselves (a citation's „Neben dem Chat öffnen“):
 * the same action, through the same runner and the same BFF gate, run at once.
 * No row: the person's own click needs no announcement.
 */
export const runViewerActionNow = async (call: ViewerActionCall): Promise<ViewerActionOutcome> => {
  if (!runner) return { outcome: 'failed' }
  return runner.run(call).catch((): ViewerActionOutcome => ({ outcome: 'failed' }))
}

/** A box in the viewer's frame (`[x0, y0, x1, y1]`) as the wire's `[x, y, w, h]`. */
const asWireRegion = (box: readonly [number, number, number, number]): number[] => [
  box[0],
  box[1],
  Math.max(0, box[2] - box[0]),
  Math.max(0, box[3] - box[1]),
]

/**
 * The viewer action a citation of a stored document opens: its box when the
 * passage was read off a drawing, its words when it was read off the text, the
 * page otherwise. A citation of the platform corpus has no workspace viewer.
 */
export const citationViewerAction = (cited: {
  documentId: string
  documentName: string
  page: number | null | undefined
  passage?: string | null
  box?: readonly [number, number, number, number] | null
}): ViewerActionCall => {
  const base = {
    document_id: cited.documentId,
    document_name: cited.documentName,
    page: cited.page ?? null,
    passage: null,
    region: null,
    against_document_id: null,
    against_document_name: null,
    element: null,
  }
  // A fresh id per press, so the same place asked again turns the viewer again.
  const id = `cite_${Date.now().toString(36)}`
  if (cited.page && cited.box) {
    return { tool_call_id: id, tool_call_name: 'highlight_region', args: { ...base, region: asWireRegion(cited.box) } }
  }
  const passage = cited.passage?.trim().slice(0, 400)
  if (cited.page && passage) {
    return { tool_call_id: id, tool_call_name: 'highlight_passage', args: { ...base, passage } }
  }
  return { tool_call_id: id, tool_call_name: 'open_document', args: base }
}

/** The person pressed „Anzeigen“: run it now, whatever the setting says. */
export const showViewerAction = (id: string): Promise<void> => execute(id)

/** The person pressed „Zurück“: the viewer goes back to where it was before this action. */
export const undoViewerAction = (id: string): void => {
  const undo = undos.get(id)
  if (!undo) return
  undos.delete(id)
  undo()
  patch(id, { status: 'undone' })
}

/** The actions of one answer, in arrival order, for its row. */
export const viewerActionsOf = (state: ViewerActionState, answerId: string): ViewerActionEntry[] =>
  (state.byAnswer[answerId] ?? []).flatMap((id) => (state.entries[id] ? [state.entries[id]] : []))

/** The actions in `view` that `previous` did not hold yet, in arrival order. */
export const newViewerActions = (
  previous: readonly ViewerActionCall[] | undefined,
  next: readonly ViewerActionCall[] | undefined
): ViewerActionCall[] => {
  if (!next || next === previous) return []
  const seen = new Set((previous ?? []).map((call) => call.tool_call_id))
  return next.filter((call) => !seen.has(call.tool_call_id))
}

/** Test hook: forget every action, the runner, the choice and the typing clock. */
export const resetViewerActions = (): void => {
  useViewerActionStore.setState({ entries: {}, byAnswer: {}, latestAnswer: null, auto: null })
  undos.clear()
  runner = null
  lastTypedAt = Number.NEGATIVE_INFINITY
}

/** Test hook: the person typed at `at`. */
export const noteTypedAt = (at: number): void => {
  lastTypedAt = at
}
