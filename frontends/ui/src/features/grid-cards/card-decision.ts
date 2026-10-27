/**
 * Card decisions — the persisted outcome of a user action on an interactive card.
 *
 * Most cards are pure presentation, but two of them ASK the user something and
 * then mutate server state: `project_profile_patch` (Accept applies a JSON
 * Patch to the project brief) and `memory_proposal` (Yes writes an org- or
 * project-scoped memory). Their answer is part of the conversation's history in
 * exactly the way `promptResponse`/`isPromptResponded` is for a HITL prompt —
 * so it lives on the `ChatMessage`, travels through both persistence layers
 * (localStorage + the `messages.metadata` jsonb), and is replayed on restore.
 *
 * Without this the card re-mounted as `pending` after every reload, offering
 * buttons that would happily apply the same patch or write the same memory a
 * second time (neither endpoint is idempotent).
 *
 * NOT persisted here: transient view state (submit spinner, request error, an
 * open PDF dialog). Those are correctly component-local — they describe an
 * attempt, not a decision.
 */

import type { GridCard } from '@/shared/cards/schemas'

/** Every card type, classified by whether it asks the user to decide something. */
export type CardInteractivity =
  /** Asks the user something and acts on the answer — the answer MUST persist. */
  | 'interactive'
  /**
   * A window onto server objects (ADR-0105, ADR-0109). Its controls write to
   * the OBJECT, and the object is the record: who decided, when and what is
   * true now are read back from it, live, by every reader. It therefore never
   * writes `cardInteractions` (`card-interactivity.spec.tsx` holds it to that).
   */
  | 'live'
  /** Read-only presentation. Nothing to remember. */
  | 'presentational'

/**
 * ⚠️ ADDING A CARD TYPE? YOU MUST CLASSIFY IT HERE. ⚠️
 *
 * This map is exhaustive over `GridCard['type']`, so the moment
 * `npm run generate:cards` regenerates the union with a new type, `tsc` fails
 * until you add a line here. That failure is deliberate — it is the only
 * checkpoint between "a new card exists" and "its user decisions are durable".
 *
 * A card that SHOWS server objects and writes to them (a mark, a proposal row)
 * is `'live'`, not `'interactive'`: the object records the decision (ADR-0105),
 * so the card must not also keep one on the message. It is still excluded from
 * surfaces and from observers like an interactive card, and a `'live'` card is
 * not done until `card-interactivity.spec.tsx` has a case that presses its
 * controls and sees nothing written to `cardInteractions`.
 *
 * If you classify a card as `'interactive'`, the card is NOT done until:
 *   1. its component takes `messageId` + `cardKey` props and drives its
 *      lifecycle from `useCardDecision` — never from local `useState`;
 *   2. `GridCards` passes it both (`messageId={messageId} cardKey={key}`);
 *   3. every terminal outcome it can reach is a member of `CARD_DECISIONS`;
 *   4. `card-interactivity.spec.tsx` covers it (that spec fails for any
 *      `'interactive'` type it does not know how to settle).
 *
 * Classify as `'interactive'` if the card writes anything, anywhere — an API
 * call, a store mutation, a decision the user would be annoyed to repeat.
 * Opening a read-only preview dialog is NOT interactive: it starts no
 * commitment, so there is nothing to remember.
 *
 * See docs/adr/0030-interactive-card-decisions-persist-on-the-message.md.
 */
export const CARD_INTERACTIVITY: Record<GridCard['type'], CardInteractivity> = {
  // Asks the user to apply a JSON Patch to the project brief.
  project_profile_patch: 'interactive',
  // Asks the user to commit an org- or project-scoped memory write.
  memory_proposal: 'interactive',
  // Asks the user to run a workspace change the agent only PROPOSED: a move, a
  // rename, a new folder, a Dokumentart, an assignment. Accepting calls the
  // same routes the Files pane calls, in this reader's session, and none of
  // them is idempotent — a card that forgot it had been accepted would move the
  // same files a second time (or fail confusingly, because they are no longer
  // where the card says they are).
  //
  // Still classified `'interactive'`, though a card that carries a `proposal_id`
  // decides on the SERVER (ADR-0105): its Accept and Discard apply or dismiss
  // the proposed change through `/api/proposals/[id]`, the object records who
  // decided and when, and nothing is written to `cardInteractions`. A card
  // without one runs nothing in the browser any more: it is read-only and only
  // replays a decision recorded before proposals were objects. The same holds
  // for `memory_proposal` and `project_profile_patch` above, except that their
  // card without a `proposal_id` still decides in the browser, for answers older
  // than server proposals. A class for "decided on the server" (`'live'`) would
  // describe all three better; see `DECIDED_ON_THE_SERVER` in
  // `card-interactivity.spec.tsx`, which it would retire.
  file_operation_proposal: 'interactive',
  // Asks the user to run an operation of the product's MCP surface that Piloti
  // only PROPOSED (ADR-0122). Decided on the server like `file_operation_proposal`
  // above: Accept and Discard go to `/api/proposals/[id]`, the object records who
  // decided, and nothing is written to `cardInteractions`. The card always carries
  // its `proposal_id`: a call that stored no proposal has no card.
  operation_proposal: 'interactive',
  // Reports the marks Piloti set on a document and the threads it answered in,
  // and asks, per proposed mark, „übernehmen oder verwerfen?" (or all at once).
  // A window onto objects, not a copy of them: the card reads the marks live
  // and the turn's changes from the server (`agent_changes`), and every answer
  // is a write to the mark itself (status move, or the server's undo), so the
  // mark is the record. Taking a mark over twice is harmless, a discarded mark
  // shows as discarded to every reader, and the `piloti-decision` score is
  // posted server-side. Nothing is written to `cardInteractions`; answers a
  // message stored before the card went live still draw read-only.
  canvas_activity: 'live',

  // The Rechenweg computes its own result from the operands it was given and
  // reveals where those numbers came from on click. Nothing is written, and
  // the disclosure is one reader's view of data that already arrived.
  calculation: 'presentational',
  // A named rule whose inputs the reader may change for a what-if (ADR-0143).
  // The changed inputs are one reader's view state in the surface's data model,
  // never written to the message or a backend, and gone on reload.
  formula: 'presentational',
  // Where Piloti looked (ADR-0128): places on a document. Opening one is a
  // read-only preview, so there is nothing to remember.
  look: 'presentational',
  // Two Fassungen side by side with the changes boxed (ADR-0128, V10): addresses of
  // documents. Opening a page is a read-only preview, so there is nothing to remember.
  revision_compare: 'presentational',
  document_grid: 'presentational',
  // Reports a draft the working directory holds, and — once it has been filed,
  // whether by Piloti or by the reader's own press — the project document it
  // became. „Zur Freigabe einreichen" on a filed card is a real write through
  // the lifecycle client: it opens an inbox item on a reviewer and moves the
  // version to `in_review`, from which it can no longer be replaced. Pressing
  // it twice is not idempotent, and a card that forgot it had been pressed
  // would ask a colleague twice.
  //
  // The UNFILED card's „Ins Projekt ablegen" files the draft directly through
  // the BFF's draft-file door, in the reader's own session, and records
  // `filed` — see `DocumentDraftCard`. The decision is record-only: a
  // `CardInteraction` carries no document id, so the open link lives in the
  // card's own mount state and a reload restores it through the same
  // idempotent press.
  document_draft: 'interactive',
  // Reports a task row the BFF has ALREADY created — `create_task` returns the
  // id this card carries. There is nothing to accept: the only controls a
  // decision could drive would repeat the delegation or cancel it, and
  // cancelling delegated work belongs to the task surface, not to a chat card.
  task_created: 'presentational',
  building_section: 'presentational',
  stair_diagram: 'presentational',
  dimension_diagram: 'presentational',
  setback_plan: 'presentational',
  egress_diagram: 'presentational',
  daylight_incidence: 'presentational',
  guardrail_check: 'presentational',
  fire_access_plan: 'presentational',
  // The 3D model viewer: orbiting, isolating a storey and selecting an element
  // are view state, not decisions — nothing is written and nothing would be
  // annoying to redo, so there is nothing to persist on the message.
  ifc_viewer: 'presentational',
  // All three read their data live from the model and write nothing. Opening
  // one, sorting it, or downloading the CSV starts no commitment.
  ifc_schedule: 'presentational',
  ifc_element: 'presentational',
  ifc_diff: 'presentational',
  // Reads its verdicts live and writes nothing. Confirming a requirement is a
  // real write, but it happens on the model page against a project — not from
  // a card, which has no project-scoped edit affordance and would strand the
  // decision on a message.
  ifc_compliance: 'presentational',
  // Lists the project's models as tiles that open the viewer on click. Opening
  // a model is plain navigation — it starts no commitment and nothing is
  // written, so there is nothing to remember.
  ifc_model_picker: 'presentational',
  // A composition of content cards (ADR-0065). Its leaves may not be
  // interactive (`SURFACE_EXCLUDED_LEAVES` in cards/models.py), because a
  // decision is keyed by a card's position in the message and a leaf has none.
  surface: 'presentational',
}

const typesClassifiedAs = (kind: CardInteractivity): Array<GridCard['type']> =>
  Object.entries(CARD_INTERACTIVITY)
    .filter(([, classified]) => classified === kind)
    .map(([type]) => type) as Array<GridCard['type']>

/** The card types whose user decisions must be persisted (see the map above). */
export const INTERACTIVE_CARD_TYPES = typesClassifiedAs('interactive')

/**
 * The card types that show server objects and write to them. They keep no
 * decision on the message, so they are not pending decisions either: nothing
 * about them waits on the message, and a reload reads the objects again.
 */
export const LIVE_CARD_TYPES = typesClassifiedAs('live')

export const isInteractiveCardType = (type: GridCard['type']): boolean =>
  CARD_INTERACTIVITY[type] === 'interactive'

export const isLiveCardType = (type: GridCard['type']): boolean => CARD_INTERACTIVITY[type] === 'live'

/**
 * Types that act (they write something), so an observer is never handed one
 * and a surface never holds one as a leaf: the two classes that are not
 * read-only presentation.
 */
export const ACTING_CARD_TYPES = [...INTERACTIVE_CARD_TYPES, ...LIVE_CARD_TYPES]

/**
 * The terminal outcomes a user can reach on an interactive card. One flat union
 * across card types: each card uses the subset it can produce, and rendering a
 * decision belonging to another card type is impossible because the key is
 * derived from the card itself.
 */
export const CARD_DECISIONS = [
  /**
   * project_profile_patch: the patch was applied to the project brief.
   * file_operation_proposal: every operation on the card was applied.
   * canvas_activity (per mark): the reader took Piloti's mark over. Read-only
   * now: the card is `live`, and the mark itself records the answer. Kept for
   * the messages that stored one.
   *
   * The file card reuses this pair rather than growing its own: the reader's
   * answer is the same answer, and the card's payload already says which verb
   * it was.
   */
  'accepted',
  /**
   * project_profile_patch / file_operation_proposal: the user declined.
   * canvas_activity (per mark): the reader discarded Piloti's mark.
   * canvas_activity (per change): the reader undid a change Piloti made for them.
   * Both are read-only fallbacks for messages stored before the card went live.
   */
  'rejected',
  /** memory_proposal: written org-wide. */
  'savedOrg',
  /** memory_proposal: written scoped to the active project. */
  'savedProject',
  /** memory_proposal: the user declined to remember it. */
  'dismissed',
  /**
   * file_operation_proposal: the reader accepted and SOME of the operations
   * failed — a file that had moved since the proposal was written, a folder
   * somebody deleted, a colleague who left the project.
   *
   * Its own outcome because the alternative is a card that says „übernommen"
   * about four moves of which three happened. Which ones failed is NOT stored
   * (a `CardInteraction` is a decision plus a timestamp, ADR-0030), so after a
   * reload the card says that some could not be applied and points at the
   * Files pane — honest about what it knows and about what it does not.
   */
  'partiallyApplied',
  /**
   * document_draft: the reader filed the unfiled draft into the project
   * themselves, through the BFF's draft-file door.
   *
   * Record-only, like every decision here: the open link is NOT stored (a
   * `CardInteraction` is a decision plus a timestamp, ADR-0030), so after a
   * reload the card knows it was filed and restores the link through the same
   * idempotent press rather than remembering it.
   */
  'filed',
  /**
   * document_draft: the filed draft was sent for approval.
   *
   * Its own outcome rather than `accepted`, which is about a proposal the
   * reader agreed to: nothing was proposed here. What happened is that a
   * version left the writing states and a person was asked to look at it, and
   * the card has to say THAT after a reload rather than „übernommen".
   */
  'submitted',
] as const

export type CardDecision = (typeof CARD_DECISIONS)[number]

/** One recorded decision: what the user chose, and when. */
export interface CardInteraction {
  decision: CardDecision
  /** ISO-8601 instant the decision was recorded (client clock). */
  decidedAt: string
}

/** A message's decisions, keyed by {@link cardKey}. */
export type CardInteractions = Record<string, CardInteraction>

/**
 * Stable identity of a card WITHIN one message.
 *
 * Cards carry no id on the wire, so identity is positional — and positions
 * only mean something because `validateGridCards` never compacts the array: a
 * card that fails validation leaves an `undefined` hole at its wire index
 * rather than renumbering what follows. Once a turn has FINALIZED, its `cards`
 * array is never mutated again — it round-trips through localStorage and
 * `metadata.cards` unchanged — so the key means the same thing for the life
 * of the message. `GridCards` uses this same value as its React key, so a
 * decision and the element it belongs to cannot drift apart.
 *
 * While a turn is still STREAMING the array is replaced wholesale on each frame
 * that carries cards; `reconcileCardInteractions` re-checks every recorded
 * decision against the new array on each such replacement.
 */
export const cardKey = (card: Pick<GridCard, 'type'>, index: number): string =>
  `${card.type}-${index}`

/**
 * The key ONE ITEM's decision is stored under, for a card that asks per item:
 * the card's key, a `#`, the item's own id (`canvas_activity` once keyed each
 * mark by its annotation id, so „take over #4, discard #5" were two decisions;
 * the card is live now and only reads those back).
 *
 * `#` because no card key contains it — `${type}-${index}`, or a surface
 * leaf's `${type}-${index}.${leafId}` — so the card an item decision belongs
 * to is always the part before it ({@link cardKeyOfDecisionKey}). The PATCH
 * route caps a key at 64 characters: `canvas_activity-19#` and a uuid are 55.
 */
export const itemDecisionKey = (key: string, itemId: string): string => `${key}#${itemId}`

/** The card a stored decision belongs to: the key itself, or the part before an item's `#`. */
export const cardKeyOfDecisionKey = (key: string): string => {
  const hash = key.indexOf('#')
  return hash === -1 ? key : key.slice(0, hash)
}

const DECISIONS: ReadonlySet<string> = new Set(CARD_DECISIONS)

export const isCardDecision = (value: unknown): value is CardDecision =>
  typeof value === 'string' && DECISIONS.has(value)

/**
 * A UTC ISO-8601 instant, matching what the PATCH route's `.datetime()` takes:
 * `Z`-terminated (no offsets), seconds required, fractional digits optional.
 *
 * Deliberately NOT `value === new Date(value).toISOString()`: that round trip
 * only accepts exactly three fractional digits, so a perfectly valid
 * second-precision instant another client wrote (`…T09:00:00Z`) would be
 * rejected and clobbered to the epoch. `Date.parse` then rejects the values the
 * shape alone lets through (month 15, day 32).
 */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && UTC_INSTANT.test(value) && !Number.isNaN(Date.parse(value))

/**
 * Drop decisions that no longer refer to the card they were made about.
 *
 * `cardKey` is positional, which is safe once a turn has finalized — but a
 * streaming answer REPLACES `message.cards` wholesale on each frame that
 * carries them, and cards render (and are clickable) while streaming. Without
 * this, a decision made against an in-progress card set could survive into a
 * different card set and describe the wrong card.
 *
 * A decision survives only if the card at its index is BYTE-IDENTICAL to the
 * one that was there before. Same-type-same-index is not enough: two successive
 * frames can both carry a `project_profile_patch` at index 0 proposing
 * different patches, and "accepted" must not carry over to a proposal the user
 * never saw. Anything else is dropped and the card returns to pending — losing
 * a record and re-asking is recoverable, attributing one card's decision to
 * another is not.
 */
export const reconcileCardInteractions = (
  interactions: CardInteractions | undefined,
  previousCards: ReadonlyArray<GridCard | undefined> | undefined,
  nextCards: ReadonlyArray<GridCard | undefined> | undefined
): CardInteractions | undefined => {
  if (!interactions) return undefined

  // Indices must stay ORIGINAL here — filtering before mapping would renumber
  // them and revive exactly the mis-attribution this guards against.
  const survivors = new Set<string>()
  ;(nextCards ?? []).forEach((card, index) => {
    // A hole is a card validation rejected: it carries no decision, and
    // `cardKey` needs a real card — so a decision once recorded against this
    // index is dropped rather than re-anchored. Losing a record and re-asking
    // is recoverable, attributing it to the card beside the hole is not.
    if (!card) return
    const previous = previousCards?.[index]
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(card)) {
      survivors.add(cardKey(card, index))
    }
  })

  // An item's decision (`itemDecisionKey`) lives and dies with its card.
  const kept = Object.entries(interactions).filter(([key]) => survivors.has(cardKeyOfDecisionKey(key)))
  return kept.length > 0 ? Object.fromEntries(kept) : undefined
}

/**
 * Narrow an untrusted `messages.metadata.cardInteractions` blob to the current
 * shape, dropping anything unrecognised. Applied on the SERVER-rehydrate path
 * (`server-message-mapper.ts`), which is the one that reads JSON this client
 * did not write — another build, another client, a hand-edited row. The
 * localStorage path is not sanitized: it is same-origin state this build wrote.
 *
 * Returns undefined when nothing usable survives, so callers can spread the
 * result without emitting an empty object.
 */
export const sanitizeCardInteractions = (raw: unknown): CardInteractions | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined

  const clean: CardInteractions = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const { decision, decidedAt } = value as { decision?: unknown; decidedAt?: unknown }
    if (!isCardDecision(decision)) continue
    clean[key] = {
      decision,
      // Must emit exactly what the PATCH route accepts. `setCardDecision`
      // re-sends the WHOLE map, so one unparseable timestamp rehydrated from a
      // foreign row would 400 every later decision on that message — and the
      // mirror only warns, so it would fail silently and permanently.
      decidedAt: isTimestamp(decidedAt) ? decidedAt : new Date(0).toISOString(),
    }
  }

  return Object.keys(clean).length > 0 ? clean : undefined
}
