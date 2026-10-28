/**
 * Piloti's viewer actions on the asker's own screen (ADR-0144).
 *
 * A `viewer_action` event is an AG-UI frontend tool call from an allow-list:
 * open a document at a page, mark a passage or a box, compare two Fassungen,
 * select a model element. It is a PROPOSAL of navigation. This module decides
 * whether the page carries it out, and keeps what the chat shows about it: a
 * row under the answer that says what moved and offers „Zurücknehmen“, or offers
 * „Anzeigen“ when it did not move.
 *
 * The rules a person can rely on:
 *  - The tool exists only for a turn whose page declared it can run it
 *    (`viewerClientTools`, sent as `user_message.client_tools`), so a phone, a
 *    tab one release older and a background run are never offered it.
 *  - Only the asker's live page runs one. The driver hands this module only
 *    the actions of turns it asked itself (`use-websocket-chat.ts`); a
 *    spectator, a replay after a reload and another tab never move anything.
 *  - Nothing moves on its own before the answer is there. An action is held
 *    while the turn runs and released when it ends with an answer
 *    (`releaseViewerActions`); a turn that fails, is stopped or ends without an
 *    answer drops what it held (`dropViewerActions`). The row shows a held
 *    place as soon as the answer is on screen, says it waits, and „Anzeigen“
 *    opens it at once: the person's press is theirs, and counts as the one
 *    place of that answer.
 *  - One place per answer moves on its own; any other is offered.
 *  - The person can turn it off (`setViewerActionsAuto`, in the row and on the
 *    profile page); with reduced motion asked of the system it starts off.
 *  - It never moves the viewer while the person is typing. It waits for a pause
 *    and offers the place if none comes.
 *  - A comparison covers the conversation and a building model leaves it, so
 *    those two are always offered, never run on their own (`CONTEXT_CHANGING`).
 *  - What it may open is decided by the BFF in the person's session, through
 *    the runner (`features/documents/lib/viewer-action-runner.ts`); a document
 *    they may not see is refused and nothing moves.
 *  - „Zurücknehmen“ says so only when it put something back: a viewer the
 *    person has since changed is left as they made it. An action that left the
 *    chat (the model view) offers it only while the page is still where it
 *    went (`noteViewerLocation`); after that there is nothing to take back, and
 *    the row drops the control rather than navigate somewhere the person did
 *    not come from.
 *
 * A name off this bundle's allow-list (a newer server's sixth action) is passed
 * over, not refused: the wire reads it as a string (`isViewerAction`).
 *
 * The runner lives with the documents feature and registers itself, the way
 * `canvas-bridge.ts` lets the review reach the chat: no import from here to there.
 */

import { create } from 'zustand'
import { MAX_VIEWER_PASSAGE_CHARS, type WireEvent } from '@/adapters/api/wire-v2'
import { capturePosthog } from '@/lib/analytics/posthog'

/** The allow-list this bundle can run. The wire carries any name; one not here is passed over. */
export const VIEWER_ACTION_NAMES = [
  'open_document',
  'highlight_passage',
  'highlight_region',
  'compare_revisions',
  'focus_ifc_element',
] as const
export type ViewerActionName = (typeof VIEWER_ACTION_NAMES)[number]

/** The frontend tool the server binds for a turn whose page declares it (`user_message.client_tools`). */
export const VIEWER_CLIENT_TOOL = 'show_in_viewer'

type WireViewerAction = Extract<WireEvent, { type: 'CUSTOM'; name: 'viewer_action' }>['value']

/** One viewer action of the allow-list: `tool_call_id`, `tool_call_name`, `args`. */
export type ViewerActionCall = Omit<WireViewerAction, 'tool_call_name'> & { tool_call_name: ViewerActionName }

const KNOWN: ReadonlySet<string> = new Set(VIEWER_ACTION_NAMES)

/** Whether this bundle can run `call`; a newer server's action is passed over. */
export const isViewerAction = (call: WireViewerAction): call is ViewerActionCall => KNOWN.has(call.tool_call_name)

/**
 * What became of one action. `held`: its turn is still running. `shown`: the
 * viewer moved and can go back. `offered`: it did not move (`reason` says why)
 * and the row offers it. `refused`: the BFF will not open it for this person.
 * `failed`: it could not be read. `undone`: „Zurücknehmen“ put the viewer back.
 * `kept`: „Zurücknehmen“ found the viewer changed since, and left it.
 */
export type ViewerActionStatus = 'held' | 'pending' | 'shown' | 'offered' | 'refused' | 'failed' | 'undone' | 'kept'
export type OfferReason = 'off' | 'typing' | 'leaves' | 'noRoom' | 'unavailable' | 'another'
/** Why a document was refused: not there for this person, or not two Fassungen of one document. */
export type RefusalReason = 'unavailable' | 'notRevisions'

/** Where a shown action put the place: beside the chat, over it (no room), the comparison, the model view. */
export type ShownWhere = 'beside' | 'over' | 'compare' | 'model'

export interface ViewerActionEntry {
  call: ViewerActionCall
  answerId: string
  status: ViewerActionStatus
  reason?: OfferReason
  refusal?: RefusalReason
  where?: ShownWhere
  /** A shown action whose place the person has left (the model view): nothing to take back, no „Zurücknehmen“. */
  left?: true
}

/** An undo says whether it put anything back. */
export type ViewerActionUndo = () => boolean

export type ViewerActionOutcome =
  | {
      outcome: 'shown'
      where: ShownWhere
      undo: ViewerActionUndo
      /** Whether the undo could still act now; absent: always. Asked when the page moves (`noteViewerLocation`). */
      undoable?: () => boolean
    }
  | { outcome: 'refused'; reason: RefusalReason }
  | { outcome: 'failed' }

export interface ViewerActionRunner {
  /** Whether the peek has room beside the chat now (`peekHasRoom`); without it a place opens over the chat. */
  hasRoom: () => boolean
  run: (call: ViewerActionCall) => Promise<ViewerActionOutcome>
}

/** How long after the last key the person counts as typing. */
export const TYPING_PAUSE_MS = 1500
/** How long an action waits for a pause before it is offered instead. */
export const TYPING_WAIT_MS = 8000
const TYPING_POLL_MS = 250
/** Where the person's choice is kept, per browser. */
export const VIEWER_ACTIONS_AUTO_KEY = 'viewerActions.auto'

let runner: ViewerActionRunner | null = null
const undos = new Map<string, ViewerActionUndo>()
const undoables = new Map<string, () => boolean>()

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
  /** Whether a viewer is mounted and has room beside the chat now: what a page declares, and what a citation offers. */
  besideChat: boolean
}

export const useViewerActionStore = create<ViewerActionState>(() => ({
  entries: {},
  byAnswer: {},
  latestAnswer: null,
  auto: null,
  besideChat: false,
}))

/** One outcome, for the product question „does anyone want this?“: kinds only, never a name or a passage. */
const record = (entry: ViewerActionEntry): void => {
  if (entry.status === 'held' || entry.status === 'pending') return
  capturePosthog('viewer_action_outcome', {
    action: entry.call.tool_call_name,
    outcome: entry.status,
    reason: entry.reason ?? entry.refusal ?? null,
  })
}

const patch = (id: string, next: Partial<ViewerActionEntry>): void => {
  const entry = useViewerActionStore.getState().entries[id]
  if (!entry) return
  const updated = { ...entry, ...next }
  useViewerActionStore.setState((state) => ({ entries: { ...state.entries, [id]: updated } }))
  if (next.status && next.status !== entry.status) record(updated)
}

/** The viewer offers itself. Returns the withdrawal, which leaves a later registration alone. */
export const registerViewerActionRunner = (next: ViewerActionRunner): (() => void) => {
  runner = next
  useViewerActionStore.setState({ besideChat: next.hasRoom() })
  return () => {
    if (runner !== next) return
    runner = null
    useViewerActionStore.setState({ besideChat: false })
  }
}

/** The host says whether the peek has room now; a citation's „Neben dem Chat öffnen“ follows it. */
export const noteViewerRoom = (room: boolean): void => {
  const besideChat = room && runner !== null
  if (useViewerActionStore.getState().besideChat !== besideChat) useViewerActionStore.setState({ besideChat })
}

/** Whether Piloti moves the viewer on its own: the person's choice, else on unless they asked for reduced motion. */
export const autoPreference = (state: { auto: boolean | null }): boolean =>
  state.auto ?? (typeof window === 'undefined' ? false : readAuto())

export const viewerActionsAuto = (): boolean => autoPreference(useViewerActionStore.getState())

export const setViewerActionsAuto = (on: boolean): void => {
  useViewerActionStore.setState({ auto: on })
  capturePosthog('viewer_actions_auto_changed', { on })
  try {
    window.localStorage.setItem(VIEWER_ACTIONS_AUTO_KEY, on ? 'on' : 'off')
  } catch {
    // Storage unavailable: the choice holds for this page.
  }
}

/**
 * The frontend tools this page can run for the next turn (AG-UI's
 * `RunAgentInput.tools`, by name): the viewer, when one is mounted with room
 * beside the chat. Empty on a phone, away from the chat, and before the viewer
 * registered; the server then never offers the tool to the model.
 */
export const viewerClientTools = (): string[] =>
  useViewerActionStore.getState().besideChat ? [VIEWER_CLIENT_TOOL] : []

/** Whether a citation offers „Neben dem Chat öffnen“: a viewer with room beside the chat, now. Reactive. */
export const useViewerBesideChat = (): boolean => useViewerActionStore((state) => state.besideChat)

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
    if (result.undoable) undoables.set(id, result.undoable)
    patch(id, { status: 'shown', reason: undefined, where: result.where })
    return
  }
  if (result.outcome === 'refused') {
    patch(id, { status: 'refused', refusal: result.reason })
    return
  }
  patch(id, { status: 'failed' })
}

/**
 * The actions that change the person's context rather than the viewer beside
 * the chat: a comparison covers the conversation, a model view leaves it. They
 * are offered and run only on a click.
 */
export const CONTEXT_CHANGING: ReadonlySet<ViewerActionName> = new Set(['compare_revisions', 'focus_ifc_element'])

const offerReason = (call: ViewerActionCall): OfferReason | null => {
  if (CONTEXT_CHANGING.has(call.tool_call_name)) return 'leaves'
  if (!viewerActionsAuto()) return 'off'
  if (!runner) return 'unavailable'
  // No room beside the chat (a phone, a route away from it): offered, and „Anzeigen“ opens it over the chat.
  if (!runner.hasRoom()) return 'noRoom'
  return null
}

/**
 * A viewer action of a turn this page asked arrived. It is held until the turn
 * ends: {@link releaseViewerActions} runs or offers it, {@link dropViewerActions}
 * forgets it.
 */
export const proposeViewerAction = (answerId: string, call: ViewerActionCall): void => {
  const id = call.tool_call_id
  if (useViewerActionStore.getState().entries[id]) return
  listenForTyping()
  useViewerActionStore.setState((state) => ({
    entries: { ...state.entries, [id]: { call, answerId, status: 'held' } },
    byAnswer: { ...state.byAnswer, [answerId]: [...(state.byAnswer[answerId] ?? []), id] },
    latestAnswer: answerId,
  }))
}

/**
 * The turn ended with its answer on screen: the first held action that may run
 * on its own runs (after a pause in the person's typing), and every other is
 * offered. One place per answer moves the viewer.
 */
export const releaseViewerActions = async (answerId: string): Promise<void> => {
  const ids = useViewerActionStore.getState().byAnswer[answerId] ?? []
  const statusOf = (id: string) => useViewerActionStore.getState().entries[id]?.status
  const held = ids.filter((id) => statusOf(id) === 'held')
  // A place the person opened while the turn ran is this answer's one move.
  let moved = ids.some((id) => statusOf(id) === 'pending' || statusOf(id) === 'shown')
  for (const id of held) {
    const entry = useViewerActionStore.getState().entries[id]
    if (!entry) continue
    const reason = moved ? 'another' : offerReason(entry.call)
    if (reason) {
      patch(id, { status: 'offered', reason })
      continue
    }
    moved = true
    patch(id, { status: 'pending' })
    if (!(await pause())) {
      patch(id, { status: 'offered', reason: 'typing' })
      continue
    }
    await execute(id)
  }
}

/** The turn ended without an answer (an error, a Stop, a hand-off): what it held never reaches the screen. */
export const dropViewerActions = (answerId: string): void => {
  const state = useViewerActionStore.getState()
  const ids = state.byAnswer[answerId] ?? []
  const dropped = ids.filter((id) => state.entries[id]?.status === 'held')
  if (dropped.length === 0) return
  const entries = { ...state.entries }
  for (const id of dropped) delete entries[id]
  const kept = ids.filter((id) => !dropped.includes(id))
  const byAnswer = { ...state.byAnswer }
  if (kept.length) byAnswer[answerId] = kept
  else delete byAnswer[answerId]
  useViewerActionStore.setState({ entries, byAnswer })
}

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
  const passage = cited.passage?.trim().slice(0, MAX_VIEWER_PASSAGE_CHARS)
  if (cited.page && passage) {
    return { tool_call_id: id, tool_call_name: 'highlight_passage', args: { ...base, passage } }
  }
  return { tool_call_id: id, tool_call_name: 'open_document', args: base }
}

/**
 * The person pressed „Anzeigen“: run it now, whatever the setting says. A held
 * one leaves the hold first, so the answer arriving meanwhile neither runs it
 * again nor moves another place.
 */
export const showViewerAction = (id: string): Promise<void> => {
  if (useViewerActionStore.getState().entries[id]?.status === 'held') patch(id, { status: 'pending' })
  return execute(id)
}

/**
 * The person pressed „Zurücknehmen“. The row says „Zurückgenommen“ only when the
 * viewer was put back; a viewer the person changed since is left, and said so.
 */
export const undoViewerAction = (id: string): void => {
  const undo = undos.get(id)
  if (!undo) return
  undos.delete(id)
  undoables.delete(id)
  patch(id, { status: undo() ? 'undone' : 'kept' })
}

/**
 * The page moved (the host's route changed). An action that left the chat and
 * whose place the person has since left has nothing to take back: its undo is
 * dropped and its row offers no „Zurücknehmen“.
 */
export const noteViewerLocation = (): void => {
  for (const [id, undoable] of [...undoables]) {
    if (undoable()) continue
    undoables.delete(id)
    undos.delete(id)
    patch(id, { left: true })
  }
}

/** The actions of one answer, in arrival order, for its row; a held one too, so the row says it waits. */
export const viewerActionsOf = (state: ViewerActionState, answerId: string): ViewerActionEntry[] =>
  (state.byAnswer[answerId] ?? []).flatMap((id) => {
    const entry = state.entries[id]
    return entry ? [entry] : []
  })

/** The actions in `next` that `previous` did not hold yet, in arrival order, and only those this bundle can run. */
export const newViewerActions = (
  previous: readonly WireViewerAction[] | undefined,
  next: readonly WireViewerAction[] | undefined
): ViewerActionCall[] => {
  if (!next || next === previous) return []
  const seen = new Set((previous ?? []).map((call) => call.tool_call_id))
  return next.filter((call) => !seen.has(call.tool_call_id)).filter(isViewerAction)
}

/** Test hook: forget every action, the runner, the choice and the typing clock. */
export const resetViewerActions = (): void => {
  useViewerActionStore.setState({ entries: {}, byAnswer: {}, latestAnswer: null, auto: null, besideChat: false })
  undos.clear()
  undoables.clear()
  runner = null
  lastTypedAt = Number.NEGATIVE_INFINITY
}

/** Test hook: the person typed at `at`. */
export const noteTypedAt = (at: number): void => {
  lastTypedAt = at
}
