/**
 * The answer's structured anatomy (`answer_meta`), made durable.
 *
 * A research answer is generated as one JSON envelope whose optional fields —
 * the headline verdict, the takeaways, the single callout — are the answer's
 * own RHETORICAL structure. The backend validates and GATES them
 * (`packages/agent/src/aiq_agent/common/answer_envelope.py`: a verdict is a copyable ≤60-char
 * VALUE, a takeaway block is earned by answer length, one callout at most) and
 * ships the survivors as the `answer_meta` wire field, versioned under `v`.
 * They are native answer fields — never cards, never in the `cards` array —
 * and the frontend renders them in a FIXED layout: verdict above the prose,
 * callout and takeaways after it.
 *
 * **The client is not trusted with the bound**, exactly as `sanitizeStages` is
 * not. This lands in `messages.metadata.answerMeta` — jsonb on a hot table fed
 * from a browser — so the key set is closed, lists are truncated and every
 * string is capped, on WRITE and again on READ (`server-message-mapper`), so a
 * row written by an older or malicious client still renders safely.
 *
 * The caps mirror the backend gates rather than inventing their own numbers:
 * this is the TypeScript half of one contract, pinned against the Python half
 * by the shared fixture `tests/fixtures/answer_meta/wire_payload.json` — a
 * crossing test on each side, so a renamed key cannot ship green.
 */

/** The contract version this build understands. */
export const ANSWER_META_VERSION = 1

/** Mirrors `VERDICT_VALUE_MAX_CHARS` — a verdict is a VALUE, not a sentence. */
export const VERDICT_VALUE_MAX_CHARS = 60
/** Mirrors `SUMMARY_MAX_CHARS` — a standfirst, not a paragraph. Gate, not cap. */
export const SUMMARY_MAX_CHARS = 320
/** The masthead's title line — a headline, not a sentence. Gate, not cap. */
export const TOPIC_MAX_CHARS = 90
/** The masthead's situating line under the title — one line, truncated. */
export const CONTEXT_MAX_CHARS = 160
const MAX_SUBJECT_CHARS = 200
const MAX_TAKEAWAYS = 5
const MAX_TEXT_CHARS = 300
const MAX_DETAIL_CHARS = 600
const MAX_REFERENCE_CHARS = 120

export const CALLOUT_KINDS = ['note', 'warning', 'deadline', 'tip'] as const
export type AnswerCalloutKind = (typeof CALLOUT_KINDS)[number]

/**
 * The German kinds a callout carried before the English names. Rows stored by
 * an older build, or written by a pod that has not rolled yet, still hold
 * them; read-only, nothing writes these.
 */
export const LEGACY_CALLOUT_KIND: Readonly<Record<string, AnswerCalloutKind>> = {
  hinweis: 'note',
  achtung: 'warning',
  frist: 'deadline',
  tipp: 'tip',
}

/** Exclusive answer shapes. A verdict is kept only for `ruling`, a work report only for `work`. */
export const ANSWER_KINDS = ['direct', 'walkthrough', 'ruling', 'handoff', 'work'] as const
export type AnswerKind = (typeof ANSWER_KINDS)[number]

/** The Fundstelle a verdict rests on; the card `NormReference` shape. */
export interface AnswerMetaReference {
  document: string
  section?: string
  edition?: string
}

export interface AnswerMetaVerdict {
  value: string
  subject: string
  reference?: AnswerMetaReference
}

export interface AnswerMetaTakeaway {
  text: string
  detail?: string
}

/** Mirrors `WORK_ITEMS_MAX` and the item caps in `answer_envelope.py`. */
export const WORK_ITEMS_MAX = 6
export const WORK_TEXT_MAX_CHARS = 200
const WORK_REF_MAX_CHARS = 80
const WORK_WHO_MAX_CHARS = 80
const WORK_DUE_MAX_CHARS = 40

/** One line of a work report: what, and optionally the object it names, who acts, and by when. */
export interface AnswerMetaWorkItem {
  text: string
  /** The object or proposal id the line is about. */
  ref?: string
  /** Who acts: the person a blocked step waits on, or who takes the next one. */
  who?: string
  /** By when, in the answer's words. */
  due?: string
}

/**
 * The report of an operations turn (`kind: work`, ADR-0123): what ran, what
 * waits for the person as a proposal, what is blocked and on whom, and what
 * comes next. Each list is optional and at most {@link WORK_ITEMS_MAX} long.
 */
export interface AnswerMetaWork {
  done?: AnswerMetaWorkItem[]
  proposed?: AnswerMetaWorkItem[]
  blocked?: AnswerMetaWorkItem[]
  next?: AnswerMetaWorkItem[]
}

export const WORK_SECTIONS = ['done', 'proposed', 'blocked', 'next'] as const
export type WorkSection = (typeof WORK_SECTIONS)[number]

export interface AnswerMetaCallout {
  kind: AnswerCalloutKind
  text: string
  title?: string
  detail?: string
}

/**
 * The stored/rendered anatomy. `v` names the contract version the writer
 * spoke; every other field is optional and absent when it did not survive the
 * backend's gates.
 */
export interface AnswerMeta {
  v: number
  /**
   * Exclusive shape. A verdict is kept only for `ruling`; an absent kind is
   * the legacy envelope and a present verdict still survives.
   */
  kind?: AnswerKind
  /** The whole answer in 1–2 sentences — the standfirst above the prose. */
  summary?: string
  /**
   * The masthead's title when no verdict was earned — the answer's subject as
   * a headline (e.g. a walkthrough's topic). Gated like the summary: over the
   * limit it was never a headline, so it is dropped whole, not truncated.
   */
  topic?: string
  /**
   * The masthead's situating line under the title — what scopes this answer
   * (instrument, edition, Land). Gated like the summary: over the limit it
   * was never a scope line, so it is dropped whole, not truncated — mirroring
   * the backend's gate, so both halves of the contract agree.
   */
  context?: string
  verdict?: AnswerMetaVerdict
  takeaways?: AnswerMetaTakeaway[]
  callout?: AnswerMetaCallout
  /** Only for `kind: work`: the report of what the turn did and what waits. */
  work?: AnswerMetaWork
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : undefined

function sanitizeReference(input: unknown): AnswerMetaReference | undefined {
  if (!isRecord(input)) return undefined
  const document = cap(input.document, MAX_REFERENCE_CHARS)
  if (!document) return undefined
  const reference: AnswerMetaReference = { document }
  const section = cap(input.section, MAX_REFERENCE_CHARS)
  if (section) reference.section = section
  const edition = cap(input.edition, MAX_REFERENCE_CHARS)
  if (edition) reference.edition = edition
  return reference
}

function sanitizeVerdict(input: unknown): AnswerMetaVerdict | undefined {
  if (!isRecord(input)) return undefined
  // The value cap is the backend's GATE, not just a bound: a longer value was
  // never a verdict, so it is dropped whole rather than truncated into one.
  const raw = typeof input.value === 'string' ? input.value.trim() : ''
  if (!raw || raw.length > VERDICT_VALUE_MAX_CHARS) return undefined
  const subject = cap(input.subject, MAX_SUBJECT_CHARS)
  if (!subject) return undefined
  const verdict: AnswerMetaVerdict = { value: raw, subject }
  const reference = sanitizeReference(input.reference)
  if (reference) verdict.reference = reference
  return verdict
}

function sanitizeTakeaways(input: unknown): AnswerMetaTakeaway[] | undefined {
  if (!Array.isArray(input)) return undefined
  const items: AnswerMetaTakeaway[] = []
  for (const raw of input) {
    if (items.length >= MAX_TAKEAWAYS) break
    if (!isRecord(raw)) continue
    const text = cap(raw.text, MAX_TEXT_CHARS)
    if (!text) continue
    const detail = cap(raw.detail, MAX_DETAIL_CHARS)
    items.push(detail ? { text, detail } : { text })
  }
  // Two is the backend's floor too: one takeaway is a sentence, not a block.
  return items.length >= 2 ? items : undefined
}

function sanitizeWorkItems(input: unknown): AnswerMetaWorkItem[] | undefined {
  if (!Array.isArray(input)) return undefined
  const items: AnswerMetaWorkItem[] = []
  for (const raw of input) {
    if (items.length >= WORK_ITEMS_MAX) break
    if (!isRecord(raw)) continue
    const text = cap(raw.text, WORK_TEXT_MAX_CHARS)
    if (!text) continue
    const item: AnswerMetaWorkItem = { text }
    const ref = cap(raw.ref, WORK_REF_MAX_CHARS)
    if (ref) item.ref = ref
    const who = cap(raw.who, WORK_WHO_MAX_CHARS)
    if (who) item.who = who
    const due = cap(raw.due, WORK_DUE_MAX_CHARS)
    if (due) item.due = due
    items.push(item)
  }
  return items.length > 0 ? items : undefined
}

function sanitizeWork(input: unknown): AnswerMetaWork | undefined {
  if (!isRecord(input)) return undefined
  const work: AnswerMetaWork = {}
  for (const section of WORK_SECTIONS) {
    const items = sanitizeWorkItems(input[section])
    if (items) work[section] = items
  }
  return Object.keys(work).length > 0 ? work : undefined
}

function sanitizeKind(input: unknown): AnswerKind | undefined {
  if (typeof input !== 'string') return undefined
  const kind = input.trim()
  if (!kind) return undefined
  // Unknown is not legacy. Legacy is ABSENT kind. Garbage that kept the
  // gavel made exclusive kinds fail open to a ruling.
  return (ANSWER_KINDS as readonly string[]).includes(kind) ? (kind as AnswerKind) : 'walkthrough'
}

function sanitizeCallout(input: unknown): AnswerMetaCallout | undefined {
  if (!isRecord(input)) return undefined
  const raw = typeof input.kind === 'string' ? input.kind : ''
  const kind = Object.hasOwn(LEGACY_CALLOUT_KIND, raw) ? LEGACY_CALLOUT_KIND[raw]! : raw
  if (!(CALLOUT_KINDS as readonly string[]).includes(kind)) return undefined
  const text = cap(input.text, MAX_TEXT_CHARS)
  if (!text) return undefined
  const callout: AnswerMetaCallout = { kind: kind as AnswerCalloutKind, text }
  const title = cap(input.title, MAX_TEXT_CHARS)
  if (title) callout.title = title
  const detail = cap(input.detail, MAX_DETAIL_CHARS)
  if (detail) callout.detail = detail
  return callout
}

/**
 * Reduce an untrusted `answer_meta` payload to a bounded one, or null when
 * nothing survives.
 *
 * A payload from a FUTURE contract version is kept (its known fields
 * sanitized, its unknown fields dropped) rather than refused: additive
 * evolution is the contract, and a rollback must not blank what a newer writer
 * stored. `v` is normalised to a number, defaulting to version 1 for a legacy
 * payload that predates the stamp.
 */
export function sanitizeAnswerMeta(input: unknown): AnswerMeta | null {
  if (!isRecord(input)) return null

  // Like the verdict, the summary's bound is the backend's GATE: over the
  // limit it was never a standfirst, so it is dropped whole, not truncated.
  const rawSummary = typeof input.summary === 'string' ? input.summary.trim() : ''
  const summary = rawSummary && rawSummary.length <= SUMMARY_MAX_CHARS ? rawSummary : undefined
  // The topic's bound is a gate in the same sense: a headline that does not
  // fit the masthead line was never a headline.
  const rawTopic = typeof input.topic === 'string' ? input.topic.trim() : ''
  const topic = rawTopic && rawTopic.length <= TOPIC_MAX_CHARS ? rawTopic : undefined
  // Like the summary, the context's bound is the backend's GATE: over the
  // limit it was never a scope line, so it is dropped whole, not truncated.
  const rawContext = typeof input.context === 'string' ? input.context.trim() : ''
  const context = rawContext && rawContext.length <= CONTEXT_MAX_CHARS ? rawContext : undefined
  const kind = sanitizeKind(input.kind)
  // Exclusive kinds: a present non-ruling kind drops the verdict. An absent
  // kind is the legacy envelope — the verdict may still survive.
  const verdict = kind && kind !== 'ruling' ? undefined : sanitizeVerdict(input.verdict)
  const takeaways = sanitizeTakeaways(input.takeaways)
  const callout = sanitizeCallout(input.callout)
  // Exclusive like the verdict: a work report belongs to a work turn only.
  const work = kind === 'work' ? sanitizeWork(input.work) : undefined
  if (!kind && !summary && !topic && !context && !verdict && !takeaways && !callout) return null

  const version = typeof input.v === 'number' && Number.isFinite(input.v) ? input.v : ANSWER_META_VERSION
  const meta: AnswerMeta = { v: version }
  if (kind) meta.kind = kind
  if (summary) meta.summary = summary
  if (topic) meta.topic = topic
  if (context) meta.context = context
  if (verdict) meta.verdict = verdict
  if (takeaways) meta.takeaways = takeaways
  if (callout) meta.callout = callout
  if (work) meta.work = work
  return meta
}
