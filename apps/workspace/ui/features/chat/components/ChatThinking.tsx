/**
 * ChatThinking — the collapsible Herleitung panel.
 *
 * Folded: the status glyph, „Herleitung · 2 Schritte · 3 Quellen zitiert“ and
 * at most one warning, the worst there is (a failed call, else an open point).
 * Expanded: the graph (`ReasoningFlow`) — the question, each step with one row
 * per call, the sources each step returned, and „Grundlagen · Entwurf“ — plus
 * the technical step tail when the reader opted in. Two turns need no panel: one
 * that looked nothing up is one line („Ohne Recherche beantwortet“), one of a
 * single call is that call. A HITL choice is answered in its own prompt card in
 * the thread, not in here. Every line binds to real streamed data or is hidden;
 * nothing is fabricated.
 */

'use client'

import {
  type FC,
  type ReactNode,
  forwardRef,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { cn } from '@/lib/utils'
import { FOCUS_RING_INSET } from '@/components/ui/focus-ring'
import {
  ChevronDown,
  CheckCircle2,
  AlertTriangle,
  CircleArrowRight,
  CircleMinus,
  CircleSlash,
  Circle,
  Clock,
  TriangleAlert,
} from 'lucide-react'
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  motion,
  AnimatePresence,
  motionBase,
  motionInstant,
  motionQuick,
  motionQuickExit,
  useIconSwapTransition,
} from '@/components/motion'
import type { Transition, Variants } from 'motion/react'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { useLayoutStore } from '@/features/layout/store'
import type { CitationSource } from '../types'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import type { RetrievalLedger } from '@/lib/conversations/message-retrieval-ledger'
import { deriveTraceLanes } from '../lib/trace-lanes'
import { buildCitationModel } from '../lib/citations'
import { liveLine } from '../lib/turn-events'
import { deriveExecutedSteps } from '../lib/executed-steps'
import { useElapsedSeconds, formatElapsed, type ElapsedSince } from '../hooks/use-elapsed-seconds'
import { ReasoningFlow } from './reasoning/ReasoningFlow'
import { SubagentGroups } from './reasoning/SubagentGroups'
import { derivationOverview, documentLocation } from '../lib/derivation-basis'
import { hasActions } from '../lib/work-list'
import { settledHead, workParts } from '../lib/work-sentence'
import { answerSourceAnchorPrefix, citationNumbers, isCited } from '../lib/citations'
import { CitationScope } from './CitationScope'
import { CitationMarkers } from './CitationMarker'
import { documentEdition, documentShortName } from '../lib/document-names'

/**
 * How a turn ended that has no answer of its own to be „Fertig" with: it
 * failed (`failed`, its error card below says how), it commissioned a run
 * (`handed_off`, the work has only begun, in the run block below), or Piloti
 * did not take it on (`refused`, said by the banner below).
 */
export type ThinkingEnding = 'failed' | 'handed_off' | 'refused'

export interface ChatThinkingProps {
  /** Array of thinking steps to display */
  steps: StoredThinkingStep[]
  /** Whether thinking is in progress (shows spinner when true, check when done) */
  isThinking?: boolean
  /** Whether the response was interrupted (page refresh / browser close mid-stream) */
  isInterrupted?: boolean
  /**
   * Whether an interrupted-answer recovery fetch is currently in flight (FIX 3).
   * When set on an otherwise-interrupted turn, the calmer "reconnecting —
   * checking for a finished answer" copy is shown instead of the "lost" notice,
   * so the UI does not race the async recovery to declare the answer gone.
   */
  isRecoveryPending?: boolean
  /** Whether waiting for user response (HITL prompt pending) */
  isWaiting?: boolean
  /**
   * The reader pressed Stop. The turn ended, but nothing was finished: the
   * header says „Gestoppt" with the neutral glyph a cancelled run carries, never
   * the green check — the last thing a stopped turn shows must not claim done.
   */
  isStopped?: boolean
  /**
   * The turn ended without an answer to be done with. Never the green check:
   * a run that has only started, or a question that was not taken on, are not
   * finished work.
   */
  endedAs?: ThinkingEnding
  /**
   * Data sources that were toggled ON in the composer when this message was
   * sent — AVAILABILITY, not activity, and therefore not rendered.
   *
   * Kept as an accepted prop because callers still pass it and because the
   * value is a real fact about the composer; what it is not is a fact about
   * what this turn did. Rendering it inside the Herleitung is exactly the
   * phantom-web-search bug: every source is enabled by default, so the row
   * claimed `Websuche` on every turn, including greetings where the backend
   * had already dropped every data-source tool. What ran comes from
   * `deriveExecutedSteps` (the `Ausgeführt:` row), which is built from the
   * turn's `tool` and `skill` steps.
   */
  enabledDataSources?: string[]
  /** Files attached to THIS message — a per-turn fact, so these are shown. */
  messageFiles?: Array<{ id: string; fileName: string }>
  /** Verbatim text of the triggering user message (framing node reframe). */
  userQuestion?: string
  /** The turn's answer confidence, if answered (assessment node). */
  answerConfidence?: 'low' | 'medium' | 'high'
  /** The turn's structured citations, if any (assessment node). */
  citations?: CitationSource[]
  /**
   * The id of the turn's answer message. Its `[N]` anchors are named after it
   * (`answerSourceAnchorPrefix`), and the Herleitung's markers use the same
   * names, so a citation is addressed the same way in both. Absent while the
   * turn has no answer yet.
   */
  answerId?: string
  /** Set when this turn escalated shallow→deep — framing-node narration. */
  escalationReason?: string
  /**
   * The answer message's `retrievalLedger` — the backend's own account of what
   * each retrieval round returned. Passed straight through to the spine, which
   * builds a round's fan from it when it has that round. Absent (older turns,
   * a turn that recorded none) and the spine matches filenames as before.
   */
  retrievalLedger?: RetrievalLedger
  /**
   * The answer has begun to stream on this live turn. The header stays live
   * (`isThinking`) until the answer settles, but stops working-shimmering: the
   * caret is the turn's one moving thing from here, and the header line says
   * what the panel holds instead of what Piloti is doing.
   */
  answering?: boolean
  /**
   * When the turn started (the question's timestamp). The elapsed figure counts
   * from here, so it reads the same however late the panel mounted.
   */
  since?: ElapsedSince
  /**
   * The settled answer's own duration. Once the turn ends the figure freezes
   * on it, so the header and the answer's footer never disagree by a second.
   */
  answerDurationMs?: number
  /** Render the Herleitung expanded on first mount (e.g. the current turn). */
  defaultOpen?: boolean
  /**
   * Turn-driven desired open state. When set, the Herleitung follows it: the
   * caller holds it open while the turn is working and lets it go the moment
   * the answer starts (the fold), so the answer streams in where the reader is
   * already looking. The reader can still toggle it by hand; a later change to
   * this value re-drives a panel the reader never touched.
   */
  autoOpen?: boolean
}

/** Why the content is leaving: the turn folded it, or the reader closed it. */
type CloseReason = 'fold' | 'toggle'

interface Disclosure {
  open: boolean
  closeReason: CloseReason
  /** The prop this state was last derived from (derive-from-props). */
  autoOpen: boolean | undefined
  /** The reader has opened or closed the panel by hand. */
  userToggled: boolean
  /** The panel is open because the TURN opened it. */
  autoOpened: boolean
}

/**
 * The next disclosure for new props, or the same object when nothing changes.
 *
 * Computed DURING render (React's "adjust state when a prop changes"), not in
 * an effect. An effect committed one render with the new props and the old
 * `open` first: the fold then started a frame late, and the content that left
 * had already re-rendered with the props it was leaving under.
 */
//
// A wait or an interruption does not open it: the choice is answered in its
// prompt card and the interruption notice sits under the header, so opening
// the graph only pushed both further from the reader.
const nextDisclosure = (d: Disclosure, autoOpen: boolean | undefined): Disclosure => {
  let next = d
  if (autoOpen !== undefined && autoOpen !== d.autoOpen) {
    const wasDriven = d.autoOpen === true
    next = { ...next, autoOpen }
    if (autoOpen && !d.userToggled) {
      // Opened by the turn (or reopened by a retracted answer). A reader who
      // has toggled this panel is never overruled.
      next = { ...next, open: true, autoOpened: true }
    } else if (!autoOpen && wasDriven) {
      // The fold: only a panel the turn opened, that the reader left alone.
      if (!d.userToggled && d.autoOpened) next = { ...next, open: false, closeReason: 'fold' }
      next = { ...next, autoOpened: false }
    }
  }
  return next
}

/**
 * The header's separator: a no-break space before the dot, so a line that
 * wraps never starts with „·“ (the dot stays with the word before it).
 */
const JOIN = '\u00A0· '

/** Phase announcements are at least this far apart, so a fast turn does not queue them. */
const PHASE_NOTE_MIN_GAP_MS = 3000

/**
 * `text`, but changing at most once per `gapMs`: a change inside the gap waits
 * for its end, and only the latest one is shown then.
 */
const useThrottledText = (text: string, gapMs: number): string => {
  const [shown, setShown] = useState(text)
  const [shownAt, setShownAt] = useState(0)
  useEffect(() => {
    if (text === shown) return
    const wait = Math.max(0, shownAt + gapMs - Date.now())
    const id = setTimeout(() => {
      setShown(text)
      setShownAt(Date.now())
    }, wait)
    return () => clearTimeout(id)
  }, [text, shown, shownAt, gapMs])
  return shown
}

type HeaderStatus =
  | 'live'
  | 'waiting'
  | 'recovering'
  | 'interrupted'
  | 'stopped'
  | 'failed'
  | 'handedOff'
  | 'refused'
  | 'done'

const ChatThinkingView: FC<ChatThinkingProps> = ({
  steps,
  isThinking = true,
  isInterrupted = false,
  isRecoveryPending = false,
  isWaiting = false,
  isStopped = false,
  endedAs,
  // `enabledDataSources` is intentionally NOT destructured: it is accepted (see
  // the prop doc) and deliberately not rendered anywhere.
  messageFiles = [],
  userQuestion = '',
  answerConfidence,
  citations,
  answerId,
  escalationReason,
  retrievalLedger,
  answering = false,
  since,
  answerDurationMs,
  defaultOpen = false,
  autoOpen,
}) => {
  const t = useTranslations(chatCopy)
  const reducedMotion = useReducedMotion()
  // With the technical steps switched on, every turn keeps its panel: they live in it.
  const showTechnicalSteps = useLayoutStore((s) => s.showTechnicalReasoning)

  const [disclosure, setDisclosure] = useState<Disclosure>(() => ({
    open: autoOpen ?? defaultOpen,
    closeReason: 'toggle',
    autoOpen,
    userToggled: false,
    autoOpened: autoOpen ?? defaultOpen,
  }))
  const derived = nextDisclosure(disclosure, autoOpen)
  if (derived !== disclosure) setDisclosure(derived)
  const { open, closeReason } = derived

  // Opening a settled Herleitung mounts its whole graph: a 190–250 ms task on
  // a 4× throttled phone, and frame gaps of 300–417 ms while the panel grew
  // (Herleitung audit, 2026-09). As a transition the mount is rendered in
  // slices the browser can paint between; the header shows the new state at
  // once through `opening`.
  const [opening, startOpening] = useTransition()
  const handleOpenChange = (next: boolean) => {
    const apply = () =>
      setDisclosure((d) => ({ ...d, open: next, closeReason: 'toggle', userToggled: true }))
    if (next && !isThinking) startOpening(apply)
    else apply()
  }

  const sourceCards = useMemo(
    () => buildCitationModel({ traceLanes: deriveTraceLanes(steps), citations }),
    [steps, citations]
  )
  // The Herleitung's `[N]` are the answer's citation markers (peek, open at the
  // page), read through a scope over the cards it draws. A scope of its own,
  // beside the answer's: the Herleitung hangs on the question's row and the
  // answer on its own, so no provider above both holds the answer's model.
  // The numbers are the wire's in both, so `[N]` names one document in each.
  const fallbackId = useId()
  const anchorPrefix = answerSourceAnchorPrefix(answerId ?? fallbackId)
  const citationScope = (node: ReactNode) => (
    <CitationScope documents={sourceCards} anchorPrefix={anchorPrefix}>
      {node}
    </CitationScope>
  )
  // Unique source cards (hits + gaps) — bar "m Quellen", not sum of Treffer.
  const sourceCount = sourceCards.length

  // The turn at a glance: its steps, what the answer cites, the one warning
  // the header carries, and whether the turn needs a graph at all.
  const overview = useMemo(() => derivationOverview(steps, sourceCards), [steps, sourceCards])
  const citedCount = overview.cited

  // Live status: what the assistant is doing right now (derived from the newest
  // streamed step) plus a seconds-elapsed cue, so a slow turn reads as active
  // work in progress rather than a frozen spinner. The count runs from the
  // question, not from this panel's mount: from the send this header IS the
  // working cue, and its figure never restarts.
  const liveActivity = liveLine(steps, t)
  const activityLabel = liveActivity ?? t('thinking.working')
  // It keeps counting through a HITL wait: the turn is still open, and a
  // figure that froze while the reader chose and then jumped by the wait read
  // as a glitch.
  const elapsedSeconds = useElapsedSeconds(isThinking || isWaiting, since)
  // Whether this mount watched the turn live: only then does the settled
  // header keep the frozen figure, so a turn does not lose its timer the
  // moment it lands, and a restored one does not grow one.
  const [sawLive, setSawLive] = useState(isThinking)
  if (isThinking && !sawLive) setSawLive(true)

  // What the status region says: the PHASE, never the per-step phrase, and
  // nothing for done or stopped, which the thread says once with the answer.
  const phaseNote = isThinking
    ? answering
      ? t('thinking.working')
      : t('thinking.inProgress')
    : isWaiting
      ? t('thinking.waiting')
      : isInterrupted
        ? isRecoveryPending
          ? t('thinking.recovering')
          : t('thinking.interrupted')
        : ''
  const spokenPhase = useThrottledText(phaseNote, PHASE_NOTE_MIN_GAP_MS)

  // "What actually ran" — one compact chip per executed agent/tool, so the
  // Herleitung names its steps without the technical-steps opt-in.
  //
  // Skill chips are LIVE-ONLY. While the turn is open they are the only place
  // the reader can see that three skills were applied, because the header line
  // replaces rather than accumulates. Once the answer lands, `SkillsUsedDisclosure`
  // sits directly beneath it and reports the same activations WITH their
  // descriptions — so keeping the chips would give one fact two owners, and the
  // one with less to say would be making the claim twice. Same label authority
  // either way (`features/skills/lib/skill-activity`), so the two can never
  // word it differently.
  //
  // A turn whose calls are drawn as rows (ADR-0132) has no tool chips: each row
  // already says what ran, where and with what result, and a chip beside it
  // would be the same claim with less to say. Skills keep theirs.
  const executedSteps = useMemo(() => {
    const rowsDrawn = hasActions(steps)
    const derivedSteps = deriveExecutedSteps(steps, t).filter((s) => !rowsDrawn || s.skill)
    if (isThinking) return derivedSteps
    return derivedSteps.filter((s) => !s.skill)
  }, [steps, t, isThinking])

  // Availability alone must never conjure a Herleitung: `enabledDataSources` is
  // non-empty on essentially every turn, so including it here made the panel
  // appear (and claim sources) for turns that did nothing.
  const hasSignal =
    steps.length > 0 ||
    messageFiles.length > 0 ||
    Boolean(answerConfidence) ||
    (citations?.length ?? 0) > 0 ||
    Boolean(escalationReason?.trim()) ||
    userQuestion.trim().length > 0

  if (!hasSignal) {
    return null
  }

  // The header line names the panel and, when there are any, counts sources.
  //
  // It carries NO step count. `steps` counts status lines, skill bookkeeping
  // and sources rows alongside the tools that ran, so the number is neither
  // turns nor calls, and read as "the agent took 19 turns". What ran is listed
  // inside, as chips.
  //
  // The source clause is ABSENT rather than „0 Quellen": an answer grounded in
  // a measurement of the model rightly has no citations, and zero reads as a
  // failure to find anything.
  //
  // Settled, the header counts the steps and what the answer CITES („2 Schritte
  // · 3 Quellen zitiert“): retrieved-but-unused documents are in the graph,
  // folded, and are not what the answer rests on.
  const summaryLabel =
    [
      citedCount > 0 || overview.steps > 0 ? t('thinking.derivationSummary') : null,
      overview.steps > 0 ? t('thinking.derivationSteps', { count: overview.steps }) : null,
      citedCount > 0 ? t('thinking.derivationCited', { count: citedCount }) : null,
    ]
      .filter(Boolean)
      .join(JOIN) ||
    (sourceCount > 0
      ? t('thinking.derivationSummaryWithSources', { count: sourceCount })
      : t('thinking.derivationSummary'))

  const status: HeaderStatus = isThinking
    ? 'live'
    : isWaiting
      ? 'waiting'
      : isInterrupted && isRecoveryPending
        ? 'recovering'
        : isInterrupted
          ? 'interrupted'
          : isStopped
            ? 'stopped'
            : endedAs === 'failed'
              ? 'failed'
              : endedAs === 'handed_off'
              ? 'handedOff'
              : endedAs === 'refused'
                ? 'refused'
                : 'done'
  // The phase in words, for the screen reader's name and the ending's word.
  const statusLabel: Record<HeaderStatus, string> = {
    live: answering ? t('thinking.working') : t('thinking.inProgress'),
    waiting: t('thinking.waiting'),
    recovering: t('thinking.recovering'),
    interrupted: t('thinking.interrupted'),
    stopped: t('thinking.stopped'),
    failed: t('thinking.failed'),
    handedOff: t('thinking.handedOff'),
    refused: t('thinking.refused'),
    done: t('thinking.done'),
  }
  // The label is the activity while Piloti works toward an answer, and the
  // panel's name (the summary) from the answer's first word on, in every state
  // after that. It does NOT change at the settle: the summary stayed where the
  // reader had it, and only the glyph (dot → check) and the frozen figure say
  // the turn is over. „Fertig" in its place swapped the label at the settle
  // and moved the summary from the left of the row to the right.
  const shimmer = status === 'live' && !answering
  const label = shimmer ? activityLabel : summaryLabel
  // The summary around its count: a new count (9 → 11 Quellen at the settle)
  // changes the digits and keeps the words. A change of the words themselves
  // (no sources → some, one source → two: the plural) re-keys the whole label.
  const countParts = shimmer ? null : splitCount(summaryLabel)
  const labelKey = shimmer
    ? `live:${label}`
    : countParts
      ? `summary:${countParts.before}#${countParts.after}`
      : `summary:${label}`
  // The one warning a settled header carries: the worst there is. A failed
  // call outranks a search that found nothing (an open point).
  const warning =
    status !== 'done'
      ? null
      : overview.failed > 0
        ? {
            kind: 'failed' as const,
            count: overview.failed,
            text: t('thinking.derivationWarning.failed', { count: overview.failed }),
          }
        : overview.open > 0
          ? {
              kind: 'open' as const,
              count: overview.open,
              text: t('thinking.derivationWarning.open', { count: overview.open }),
            }
          : null
  // The phase in a word: what the trigger is named by and what is announced.
  const phaseWord = statusLabel[status]
  // An ending that is not „done" says so in a word on the right, beside the
  // figure, where it moves nothing on the left.
  const endingWord = status === 'live' || status === 'done' ? null : statusLabel[status]

  // The figure ticks while the turn works and FREEZES when it ends — on the
  // answer's own duration when the footer has one — instead of vanishing.
  // Never below the last live figure, which the count froze on: the duration
  // is measured from the send and the count from the question's timestamp, a
  // few hundred ms apart, and a settle that ticked the figure BACK by a second
  // read as a glitch at the one moment the reader looks at it.
  const shownSeconds =
    !isThinking && answerDurationMs !== undefined
      ? Math.max(Math.floor(answerDurationMs / 1000), sawLive ? elapsedSeconds : 0)
      : elapsedSeconds
  // Only while the turn works: settled, the total time went by the value test
  // (no one checks an answer by its seconds; the footer and Langfuse keep it).
  const showElapsed = sawLive && shownSeconds > 2 && (isThinking || isWaiting)

  // Every state swap in the header runs on the house pair, entrance easing in
  // and exit easing out: the icon and the right-hand words cross-fade, the
  // label and its count roll. Reduced motion: instant.
  const enter = reducedMotion ? motionInstant : motionQuick
  const leave = reducedMotion ? motionInstant : motionQuickExit
  const swap = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: enter },
    exit: { opacity: 0, transition: leave },
  }
  // The label's and the count's swap: a vertical roll. The old text fades on
  // the exit easing, but both TRAVEL on the entrance one, in lockstep, so they
  // stay exactly one line apart. On its own exit easing the old one barely
  // moved while the new one, already most of the way in, slid up under it.
  const roll: RollMotion = {
    initial: { opacity: 0, y: ROLL_OFFSET },
    animate: { opacity: 1, y: 0, transition: enter },
    exit: { opacity: 0, y: `-${ROLL_OFFSET}`, transition: { ...leave, y: enter } },
  }

  // Two turns need no graph. One that looked nothing up says so in one line;
  // one that made a single call is that call, and the header is the Herleitung.
  // Neither opens: there is nothing behind it.
  if (
    status === 'done' &&
    !overview.researched &&
    !escalationReason?.trim() &&
    !showTechnicalSteps
  ) {
    return (
      <div
        data-testid="derivation-no-research"
        className="bg-muted w-full rounded-surface px-4 py-3 shadow-xs"
      >
        <p className="text-foreground flex min-h-6 items-center gap-2 text-sm font-medium">
          <CircleMinus aria-hidden className="text-muted-foreground size-5 shrink-0" />
          {t('thinking.noResearch')}
        </p>
        <p className="text-muted-foreground pl-7 text-[13px] leading-[19px]">
          {t('thinking.noResearchNote')}
        </p>
      </div>
    )
  }
  if (status === 'done' && overview.single && !showTechnicalSteps) {
    const call = overview.single
    const parts = workParts(t, call.action)
    const card = sourceCards[0]
    const cited = card && isCited(card) ? citationNumbers(card) : []
    // The document by its name, and its place on the second line beside the
    // edition and the marker: „Liest Brandschutzkonzept“ / „S. 7 · zitiert [1]“.
    // Without a card the call's own words and its result stand.
    const name = card ? documentShortName(card.fileName ?? card.title, card.title) : ''
    const head = settledHead(t, call.action, name)
    const detail = [
      card ? documentEdition(card.fileName ?? card.title, card.title) : undefined,
      card ? documentLocation(t, card) : parts.result || undefined,
    ].filter(Boolean)
    // „zitiert {markers}“ around the answer's own marker, so „1“ here peeks
    // and opens what „1“ in the prose does.
    const [citedBefore = '', citedAfter = ''] = t('thinking.singleCited').split('{markers}')
    const citedPart =
      cited.length > 0 ? (
        <>
          {citedBefore}
          <CitationMarkers numbers={cited} />
          {citedAfter}
        </>
      ) : null
    return citationScope(
      <div
        data-testid="derivation-single"
        className="bg-muted grid w-full grid-cols-[20px_minmax(0,1fr)] gap-x-2 rounded-surface px-4 py-3 shadow-xs"
      >
        <CheckCircle2 aria-hidden className="text-success size-5" />
        <p className="text-sm leading-5 [overflow-wrap:anywhere]">
          <span className="text-foreground font-medium">{head}</span>
          {(detail.length > 0 || citedPart) && (
            <span className="text-muted-foreground block text-[13px] leading-[19px]">
              {detail.join(JOIN)}
              {detail.length > 0 && citedPart && JOIN}
              {citedPart}
            </span>
          )}
        </p>
      </div>
    )
  }

  // No entrance of its own: it mounts with its question, and the thread row
  // (`ChatArea`) owns that entrance, gated so a restored turn does not replay it.
  return citationScope(
    // `@container`: the header answers to the panel's width, not the
    // viewport's: the panel sits in a chat column, beside a canvas or a
    // sidebar, and is a phone's width there on any screen.
    <div className="@container w-full rounded-surface bg-muted shadow-xs">
      <Collapsible open={open || opening} onOpenChange={handleOpenChange}>
        <CollapsibleTrigger asChild aria-controls={undefined /* no CollapsibleContent to name */}>
          {/* The trigger's name is the PHASE and the panel (`sr-only` below),
              not the visual line: the live activity phrase changes with every
              step, and a button whose name changes that often is re-read on
              every change, a queue of phrases already out of date. The
              phase is announced from a status outside the button. */}
          <button
            type="button"
            data-derivation-trigger
            className={cn(
              'group relative flex min-h-12 w-full cursor-pointer items-center justify-between rounded-control px-4 py-3 text-left outline-none transition-colors duration-snap ease-out motion-reduce:transition-none',
              // Inset: the trigger is the panel's full width, and an offset
              // ring would sit outside the panel's own rounded edge.
              FOCUS_RING_INSET
            )}
          >
            <span className="sr-only">
              {[phaseWord, summaryLabel, warning?.text].filter(Boolean).join(' · ')}
            </span>
            {/* `relative`: `popLayout` lifts the leaving icon and phrase out of
                the flow, positioned against this box. */}
            {/* One line in every state: the warning pill arrives at the
                settle, and a row that wrapped for it grew the header under
                the reader's eye. The label gives way (ellipsis) instead; the
                trigger's `sr-only` name above carries it whole. */}
            <span
              className="relative flex min-w-0 flex-nowrap items-center gap-x-2"
              aria-hidden="true"
            >
              {/* Fixed icon slot, shared by every state: without it the text
                  starts at a different x whenever the status changes, and the
                  row visibly jumps at the moment the reader looks at it. */}
              <AnimatePresence mode="popLayout" initial={false}>
                <StatusIcon key={status} status={status} t={t} enter={enter} leave={leave} />
              </AnimatePresence>
              {/* The label rolls: the old one leaves upward, fading, while the
                  new one rises into its place from below, overlapping
                  (`popLayout`) inside a clip one line tall. Neither `wait` nor
                  a cross-fade at one origin: `wait` left the header with no
                  label for a few frames at the fold and the settle, and two
                  phrases superimposed at one origin read as one garbled word
                  („Fertigtung"). Offset vertically, they never share a
                  position while both are legible.

                  Keyed by the label's WORDS, not its count: when only the
                  source count changes (it often does at the settle), this
                  node stays and only the digits roll (`RollingCount`). */}
              <span className="relative max-w-[calc(100%-1.75rem)] min-w-0 overflow-y-clip">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={labelKey}
                    data-derivation-label
                    className={cn(
                      'block truncate text-sm font-medium',
                      shimmer ? undefined : 'text-foreground'
                    )}
                    {...roll}
                  >
                    {/* The one ambient loop before the answer: the shimmer, on an
                        inner element that moves by transform only, since the
                        roll owns this span's opacity. */}
                    {shimmer ? (
                      <ShimmerText className="block">{label}</ShimmerText>
                    ) : countParts ? (
                      <>
                        {countParts.before}
                        <RollingCount value={countParts.count} after={countParts.after} roll={roll} />
                      </>
                    ) : (
                      label
                    )}
                  </motion.span>
                </AnimatePresence>
              </span>
              {warning && (
                <span
                  data-testid="derivation-warning"
                  className="bg-card text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-px text-[13px] font-medium"
                >
                  {warning.kind === 'failed' ? (
                    <TriangleAlert aria-hidden strokeWidth={2.4} className="size-3" />
                  ) : (
                    <Circle aria-hidden strokeWidth={2.4} className="size-3" />
                  )}
                  {/* A narrow panel keeps the summary whole and the pill to
                      its shape and count; the trigger's `sr-only` name and
                      the panel's „Offen“ carry the words. */}
                  <span className="@sm:hidden">{warning.count}</span>
                  <span className="hidden @sm:inline">{warning.text}</span>
                </span>
              )}
            </span>

            <span className="relative flex shrink-0 items-center gap-2" aria-hidden="true">
              {/* The ending word rolls like the label beside it. `wait` left
                  the slot empty for the whole exit before the next word came. */}
              <span className="relative overflow-y-clip empty:hidden">
                <AnimatePresence mode="popLayout" initial={false}>
                  {endingWord && (
                    <motion.span key={endingWord} className="block text-xs font-medium text-muted-foreground" {...roll}>
                      {endingWord}
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
              <AnimatePresence mode="popLayout" initial={false}>
                {showElapsed && (
                  // A reserved width and tabular digits, so 9 s → 10 s does
                  // not nudge what sits beside it.
                  <motion.span
                    key="elapsed"
                    className="min-w-[3.5ch] text-right text-xs font-medium tabular-nums text-muted-foreground"
                    {...swap}
                  >
                    {formatElapsed(shownSeconds)}
                  </motion.span>
                )}
              </AnimatePresence>
              {/* While the label is the activity, the summary sits here once
                  the PANEL is 28rem wide: beside it, at 390 px, the label read
                  only „Such…" (Herleitung audit, 2026-09). A container query,
                  not `sm:`: a wide window with a narrow chat column is a phone
                  to this header. From the answer's first word the label IS the
                  summary, and this slot stays empty for good. */}
              {shimmer && <span className="hidden text-xs text-muted-foreground @md:inline">{summaryLabel}</span>}
              <ChevronDown className="size-4 text-muted-foreground transition-transform duration-quick ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
            </span>
          </button>
        </CollapsibleTrigger>

        {/* Expanded content. It fades in (no height: growing it laid the page
            out on every frame while the graph inside was still mounting, 300–
            417 ms frame gaps on a phone, Herleitung audit 2026-09).

            How it leaves depends on why (`custom`). The FOLD, when the answer
            starts: the content fades on the exit easing with its height held,
            then gives up its height in one frame while invisible, so the reader
            never watches a box slide. A reader's own close keeps the collapse
            (height and opacity together), on the exit easing. Reduced motion:
            both instant. `overflow-hidden` so the collapse clips. */}
        <AnimatePresence initial={false} custom={{ reason: closeReason, reducedMotion }}>
          {open && (
            <motion.div
              key="derivation-content"
              custom={{ reason: closeReason, reducedMotion }}
              variants={contentVariants}
              initial="hidden"
              animate="shown"
              exit="leave"
              // `overflow-anchor: none`: the browser must not pick its scroll
              // anchor inside a box that is about to leave, or it scrolls the
              // page to follow it while it collapses.
              className="overflow-hidden [overflow-anchor:none]"
            >
              <div>
                  <div className="border-base border-t px-2 pb-3 pt-3 sm:px-4">
                    <ReasoningFlow
                      steps={steps}
                      userQuestion={userQuestion}
                      answerConfidence={answerConfidence}
                      citations={citations}
                      escalationReason={escalationReason}
                      retrievalLedger={retrievalLedger}
                      live={isThinking}
                      sourceCards={sourceCards}
                    />
                  </div>

                  {/* The subagents the turn ran (AG-UI 1.0 SUBAGENT_*), nested; nothing without one. */}
                  <SubagentGroups steps={steps} className="border-base border-t px-4 pb-3 pt-3" />

                  {/* Executed steps — what actually ran, as compact chips, under
                      the graph; a running one breathes. */}
                  {executedSteps.length > 0 && (
                    <div className="border-base flex flex-col gap-2 border-t px-4 pb-3 pt-3">
                      <SectionLabel>{t('thinking.executedSteps')}</SectionLabel>
                      <div className="flex flex-wrap gap-1.5">
                        {executedSteps.map((s) => (
                          <span
                            key={s.key}
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-control bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground"
                          >
                            {s.running && (
                              <span
                                aria-hidden="true"
                                className="size-1.5 animate-caret-breathe rounded-full bg-brand motion-reduce:animate-none"
                              />
                            )}
                            {/* A skill with no authored title is named by its bare
                                `/identifier`, so the identifier half renders
                                `font-mono` — the same way `SkillsUsedDisclosure`
                                writes it under the finished answer. One label
                                authority, one appearance. */}
                            {s.mono ? (
                              <>
                                {s.prefix && <span>{s.prefix}</span>}
                                <span className="font-mono">{s.mono}</span>
                              </>
                            ) : (
                              s.label
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Collapsible>

      {/* The phase, said politely and at most every few seconds — outside the
          button, on a region mounted with the panel. A settled or stopped turn
          is said by the thread (`ChatArea`), once, with the answer's gist. */}
      <span className="sr-only" role="status" aria-live="polite">
        {spokenPhase}
      </span>

      {/* Mid-turn drop notice: a silent reconnect can leave a turn without any
          response. The collapsed header only shows a muted "Interrupted" chip,
          which does not tell the user what to do — so surface a compact,
          always-visible line (protocol-robustness item 4). While recovery is
          still in flight (FIX 3) show a calm "checking for a finished answer"
          line; only once recovery has settled with nothing found do we prompt
          a resend. */}
      {isInterrupted && isRecoveryPending ? (
        <div className="flex items-start gap-2 border-t border-border px-4 pb-3 pt-2.5">
          <Spinner
            size="xs"
            className="mt-0.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="text-xs leading-relaxed text-muted-foreground" role="status">
            {t('thinking.recoveringNotice')}
          </span>
        </div>
      ) : isInterrupted ? (
        <div className="flex items-start gap-2 border-t border-border px-4 pb-3 pt-2.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="text-xs leading-relaxed text-muted-foreground" role="status">
            {t('thinking.interruptedNotice')}
          </span>
        </div>
      ) : null}
    </div>
  )
}

/**
 * How far a rolling label or count travels: its own height, one line, inside a
 * clip one line tall. The old text leaves the window as the new one enters it,
 * so the two never cover each other. A shorter travel (0.4em was tried, phone
 * recording 2026-10) kept both wholly inside the window, half-transparent and
 * a few pixels apart: „9" over „11" read as one smudged number.
 */
const ROLL_OFFSET = '100%'

interface RollMotion {
  initial: { opacity: number; y: string | number }
  animate: { opacity: number; y: number; transition: Transition }
  exit: { opacity: number; y: string; transition: Transition }
}

/** The first number in `text` (grouping separators included), and the text around it. */
const splitCount = (text: string): { before: string; count: string; after: string } | null => {
  const match = /\d+(?:[.,\u00a0\u202f]\d{3})*/.exec(text)
  if (!match) return null
  return {
    before: text.slice(0, match.index),
    count: match[0],
    after: text.slice(match.index + match[0].length),
  }
}

/**
 * A count whose digits roll when it changes: the old number leaves upward and
 * the new one rises from below, overlapping, clipped to the line.
 *
 * When the number gains or loses a digit the box takes its new width in one
 * frame and the words after it (`after`) glide from where they stood by
 * transform, on the roll's own timing, so 9 → 11 at the settle slides rather
 * than jumps. It used to tween the box's `width`, which re-laid out the line
 * on every frame of the roll; a translate is composited. `align-top` with the
 * inherited line height keeps the digits on the text's baseline: a clipping
 * inline box would otherwise sit on its bottom edge.
 */
const RollingCount: FC<{ value: string; after: string; roll: RollMotion }> = ({ value, after, roll }) => {
  const sizer = useRef<HTMLSpanElement>(null)
  const tail = useRef<HTMLSpanElement>(null)
  const lastWidth = useRef<number | null>(null)
  // Before paint, so the first frame already shows the tail where it stood. A
  // Web Animation with no fill: when it ends the tail is untransformed again.
  useLayoutEffect(() => {
    // Measured on an absolute sizer: the leaving number is still in the box
    // while it rolls out, so the box itself cannot say how wide the new one is.
    const next = sizer.current?.getBoundingClientRect().width ?? 0
    const previous = lastWidth.current
    lastWidth.current = next
    const duration = (roll.animate.transition.duration ?? 0) * 1000
    if (previous === null || Math.abs(previous - next) < 0.5 || duration === 0) return
    tail.current?.animate?.(
      [{ transform: `translateX(${previous - next}px)` }, { transform: 'translateX(0)' }],
      { duration, easing: cssEasing(roll.animate.transition.ease) }
    )
  }, [value, roll.animate.transition])
  return (
    <>
      <span className="relative inline-grid overflow-hidden align-top tabular-nums">
        {/* Generated content, so the sizer's digits are not in the label's text. */}
        <span
          ref={sizer}
          aria-hidden="true"
          data-text={value}
          className="invisible absolute whitespace-nowrap before:content-[attr(data-text)]"
        />
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={value} data-derivation-count className="col-start-1 row-start-1" {...roll}>
            {value}
          </motion.span>
        </AnimatePresence>
      </span>
      <span ref={tail} className="inline-block whitespace-pre">
        {after}
      </span>
    </>
  )
}

/** A motion `ease` as a CSS timing function, for a Web Animation. */
const cssEasing = (ease: Transition['ease']): string =>
  Array.isArray(ease) && ease.length === 4 && ease.every((n) => typeof n === 'number')
    ? `cubic-bezier(${ease.join(', ')})`
    : 'ease-out'

/** What decides how the expanded content leaves (`AnimatePresence` `custom`). */
interface ContentExit {
  reason: CloseReason
  reducedMotion: boolean
}

const contentVariants: Variants = {
  hidden: { opacity: 0 },
  shown: ({ reducedMotion }: ContentExit) => ({
    opacity: 1,
    height: 'auto',
    transition: reducedMotion ? motionInstant : motionBase,
  }),
  leave: ({ reason, reducedMotion }: ContentExit) => {
    if (reducedMotion) return { opacity: 0, height: 0, transition: motionInstant }
    if (reason === 'toggle') return { opacity: 0, height: 0, transition: motionQuickExit }
    // The fold: fade with the height held, then drop the height in one frame
    // once nothing of it is visible.
    return {
      opacity: 0,
      height: 0,
      transition: {
        opacity: motionQuickExit,
        height: { duration: 0, delay: motionQuickExit.duration },
      },
    }
  },
}

interface StatusIconProps {
  status: HeaderStatus
  t: ReturnType<typeof useTranslations>
  enter: Transition
  leave: Transition
}

/**
 * The header's fixed 20 px icon slot, one keyed child per status so the slot
 * cross-fades. While the turn works it spins, beside the label's shimmer: a
 * static dot read as a stalled turn, and people watch this header to see the
 * agent is still at it (2026-10). The settle's check arrives with a small
 * spring (scale 0.7 → 1) — the end of the turn is the moment worth marking.
 */
const StatusIcon = forwardRef<HTMLSpanElement, StatusIconProps>(function StatusIcon(
  { status, t, enter, leave },
  ref
) {
  const settled = status === 'done'
  // The check's pop: a spring on scale only, its opacity on the quick tween
  // (opacity has nothing to overshoot), both instant under reduced motion.
  const iconSwap = useIconSwapTransition()
  const glyph: Record<HeaderStatus, ReactNode> = {
    live: <Spinner size="sm" label={t('thinking.inProgress')} />,
    waiting: <Clock className="size-5" aria-hidden="true" />,
    recovering: <Spinner size="sm" aria-hidden="true" />,
    interrupted: <AlertTriangle className="size-5" aria-hidden="true" />,
    stopped: <CircleSlash className="size-5" aria-hidden="true" />,
    failed: <AlertTriangle className="size-5" aria-hidden="true" />,
    handedOff: <CircleArrowRight className="size-5" aria-hidden="true" />,
    refused: <CircleMinus className="size-5" aria-hidden="true" />,
    done: <CheckCircle2 className="size-5" aria-hidden="true" />,
  }
  const tone: Record<HeaderStatus, string> = {
    live: '',
    waiting: 'text-brand',
    recovering: 'text-muted-foreground',
    interrupted: 'text-warning',
    stopped: 'text-muted-foreground',
    failed: 'text-warning',
    handedOff: 'text-brand',
    refused: 'text-muted-foreground',
    done: 'text-success',
  }
  return (
    <motion.span
      ref={ref}
      className={cn('flex size-5 shrink-0 items-center justify-center', tone[status])}
      initial={settled ? { opacity: 0, scale: 0.7 } : { opacity: 0 }}
      animate={{
        opacity: 1,
        scale: 1,
        transition: settled ? iconSwap.enter : enter,
      }}
      exit={{ opacity: 0, transition: leave }}
    >
      {glyph[status]}
    </motion.span>
  )
})

/**
 * Memoised: the thread renders one per turn, and the list re-renders on every
 * delta flush of the live answer. Unmemoised, every earlier turn's Herleitung
 * re-rendered per flush (723 renders in one answer of a 40-message thread,
 * React performance audit 2026-09). ChatArea keeps `steps` referentially
 * stable for that reason.
 */
export const ChatThinking = memo(ChatThinkingView)
