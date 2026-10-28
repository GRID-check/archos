import type { GridCard } from '@/shared/cards/schemas'
import type { CitationSource } from '../../types'
import type { AnswerConfidenceCappedReason } from '@/lib/conversations/message-provenance'
import type { MessageStages } from '@/lib/conversations/message-stages'
import type { CardInteractions } from '@/features/grid-cards/card-decision'
import type { AnswerMeta } from '@/lib/conversations/message-answer-meta'
import type { Finding, Findings } from '@/lib/conversations/message-findings'

import type { RetrievalLedger } from '@/lib/conversations/message-retrieval-ledger'
import type { QuoteStamp } from '@/lib/conversations/message-quote-stamps'
import type { ConfidenceCheck } from '@/lib/conversations/confidence-check'

export interface AgentResponseProps {
  /** Response content from the agent */
  content: string
  /** Timestamp of the response (Date or ISO string from persisted state) */
  timestamp?: Date | string
  /** How long the answer took, question sent to answer final, in milliseconds. */
  answerDurationMs?: number
  /** Display variant - 'default' has box styling, 'inline' has no box (for use inside containers) */
  variant?: 'default' | 'inline'
  /**
   * Grid cards attached to this answer. Each is drawn where the answer placed
   * it with a `[[card:N]]` marker (N is 1-based over this array); the ones no
   * marker claimed follow the prose as a block. Positions are identity: a
   * rejected card leaves an `undefined` hole rather than renumbering the rest
   * (see `validateGridCards`), and a hole renders nothing.
   */
  cards?: (GridCard | undefined)[]
  /**
   * Citations already collected for this answer (deep-research path). Drives
   * the "Belegt durch" chip row — renders nothing when absent (no fake chips).
   */
  citations?: CitationSource[]
  /** Conversation this response belongs to (keys the per-answer feedback row) */
  conversationId?: string | null
  /**
   * The reader's answer to each interactive card of this answer, keyed by
   * `cardKey`. Needed HERE, not only inside the cards, because a
   * `memory_proposal` only becomes something Piloti remembered once the reader
   * says yes — and the „Piloti hat sich gemerkt" chip must not claim a write
   * that has not happened.
   */
  cardInteractions?: CardInteractions
  /**
   * What a POST-ANSWER STAGE computed for this turn
   * (`docs/architecture/post-answer-stages.md` §4.3). Only
   * `memoryReflection` is read here; the follow-ups rail is a SIBLING of this
   * component in the thread column, not part of the answer card (§6.1).
   */
  stages?: MessageStages
  /**
   * The answer's structured anatomy (verdict / takeaways / callout) — native
   * answer fields with a FIXED layout: the verdict renders above the prose,
   * the callout and the takeaways after it. Gated backend-side and sanitized
   * at every boundary; never part of `cards`.
   */
  answerMeta?: AnswerMeta
  /** The report's findings, drawn as the Befundmatrix between the masthead and the prose. */
  findings?: Findings
  /** The previous report's findings on the same subject, for the matrix's change marks. */
  previousFindings?: Findings
  /** Commission a run to clear an open finding; absent when the thread cannot. */
  onCommissionFinding?: (finding: Finding) => Promise<boolean>
  /** The assistant's guarded self-assessed answer confidence (shallow answers only) */
  answerConfidence?: 'low' | 'medium' | 'high'
  /**
   * Why the self-assessed confidence was capped (WP-A transparency extra) —
   * `'ungrounded'` or `'quote_unverified'` add the matching cap explanation to
   * the ConfidenceChip tooltip (PB-9).
   */
  answerConfidenceCappedReason?: AnswerConfidenceCappedReason
  /**
   * The model's own one-clause justification for its confidence level, shown
   * verbatim in the ConfidenceChip tooltip.
   */
  answerConfidenceReason?: string
  /** What the answer check found (`TurnResult.confidence_check`, ADR-0139); the chip names its findings. */
  confidenceCheck?: ConfidenceCheck
  /** Which rule computed the confidence: 2 the per-sentence formula; absent on older answers. */
  answerConfidenceVersion?: 1 | 2
  /** A search ran and found nothing; the answer is the model's own knowledge, said in a note. */
  lookupFoundNothing?: true
  /**
   * Citation-verification result: how many citations were removed as
   * unverifiable, with de-duplicated reasons. Renders a muted note inside the
   * answer details, whose trigger carries a warning dot when it is present.
   */
  citationsRemoved?: { count: number; reasons: string[] }
  /**
   * Retrieved-but-uncited documents for this answer (document key +
   * lane/kind + page, no prose). Renders the collapsed "Gelesen, nicht
   * zitiert" disclosure inside the answer details; absent when everything
   * retrieved was cited.
   */
  readSources?: CitationSource[]
  /**
   * The turn's research was cut off at its budget ceiling: this answer rests on
   * the evidence gathered up to that point rather than on a finished search.
   * Renders one muted line inside the answer details, whose trigger carries a
   * warning dot when it is present — a fact about the EVIDENCE, in the same register
   * as the sources row. Never a badge on the
   * answer and never folded into the confidence chip: that grades whether the
   * claims are sourced, which a truncated answer can be, perfectly.
   */
  researchTruncated?: true
  /**
   * WHY it was cut off, as the backend's stable token (`wall_clock`,
   * `step_limit`). Appended to the line above as a short parenthetical.
   *
   * Typed `string`, not the union, deliberately: this crosses a version
   * boundary — a newer backend can name a cutoff cause this build has never
   * heard of — and the component's contract is that it renders only tokens it
   * has a sentence for. An unknown one renders NOTHING; it is never shown raw,
   * because `wall_clock` under an answer about Fluchtwegbreiten is noise that
   * looks like a defect.
   */
  truncationReason?: string
  /**
   * Ways this answer is weaker than one from a finished run, as stable tokens
   * (`no_report_file`, `no_valid_citations`). Same token contract as above:
   * de-duplicated, unknown entries dropped, an empty list rendering nothing —
   * "degraded in zero ways" is the ordinary case and is not stated.
   */
  degradedReasons?: string[]
  /**
   * Skills whose full instructions the agent loaded while writing this answer
   * (a `read_file` of its `SKILL.md`), in activation order. Absent on a turn that activated none,
   * which is the common case — availability is not activation.
   */
  skillsActivated?: string[]
  /**
   * The `grid-hidden` subset of `skillsActivated` — a skill that runs on every
   * answer (the house voice), muted in the disclosure until the reader turns on
   * the reasoning view. Named there, never dropped.
   */
  skillsHidden?: string[]
  /**
   * The reader's `showReasoningSkills` preference. Passed in from the list
   * parent rather than read here, because this component renders once PER
   * MESSAGE — a hook that fetches the preference on mount would fire one GET per
   * answer in the thread and re-render every message when it settled. Defaults
   * to closed, so the muted rows stay muted for the SpectatedTurn and dev
   * surfaces that do not thread it.
   */
  showReasoning?: boolean
  /**
   * Client-side message identifier of this answer — keys the per-answer
   * thumbs feedback row (WS-7). No feedback row renders when absent (e.g.
   * legacy callers), so existing usages are unaffected.
   */
  messageId?: string
  /**
   * Whether this answer is still streaming (C6). Drives the blinking caret at
   * the end of the answer body and the partial-markdown stabilizer in the
   * MarkdownRenderer. Threaded from `message.isStreaming` by ChatArea.
   */
  isStreaming?: boolean
  /**
   * Which path the turn turned out to take, observed after the answer (WP-A
   * transparency extra). `'meta'` marks a conversational / clarifying reply (greetings,
   * capability questions, Rückfragen) — rendered with a quiet neutral "Hinweis"
   * role tab when the envelope has no `kind`. Envelope `kind` wins when present:
   * `direct` → Hinweis, `walkthrough` → Antwort, `ruling` (or a legacy
   * no-kind verdict) → Ergebnis. Absent/`'error'` fall back to the "Ergebnis"
   * treatment, so existing callers render exactly as before.
   */
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  /**
   * Somebody else's turn, drawn for a colleague reading along
   * (`SpectatedTurn`, ADR-0039 §5). No card acts — every interactive card
   * draws without its actions, and none is given the reader's project or the
   * message to record a decision on — and neither feedback nor copy actions
   * are offered over an answer that is about to be replaced by the persisted
   * one, which carries its own. A file the answer names still links.
   */
  readOnly?: boolean
  /**
   * The backend's account of the turn's retrieval rounds. Read here for the
   * „Gesucht in" pane of a `:::not-found`, which lists what the turn searched
   * from this record and never from the model's words.
   */
  retrievalLedger?: RetrievalLedger
  /** The server's check of each quote line (`TurnResult.quote_stamps`), for „Wortlaut belegt [N]". */
  quoteStamps?: QuoteStamp[]
  /**
   * The project profile `:project[key]` binds, when the caller has it (a
   * preview, a spec). Omitted, the open project's profile is fetched once for
   * the thread (`useProjectFacts`).
   */
  projectProfile?: unknown
  /**
   * The reader pressed Stop on this turn (`ChatMessage.stopped`). The answer
   * keeps what was on screen at the press, says „Gestoppt" where the writing
   * ended, and does not claim to be complete: the role tab's check is held
   * back, as for a turn still running.
   */
  stopped?: boolean
  /**
   * The turn failed (`RUN_ERROR`) under this answer (`ChatMessage.failed`).
   * What had been shown stays, frozen as for Stop and dimmed, with the error
   * card the thread puts under it; nothing in the footer becomes operable,
   * because a cut-off fragment is not an answer to copy or rate.
   */
  failed?: boolean
}
