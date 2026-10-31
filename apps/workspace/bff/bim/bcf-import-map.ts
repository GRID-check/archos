/**
 * A BCF topic onto an Anmerkung: the ONE mapping of the import, the reverse
 * of `./bcf3-build.ts`. Pure: no `server-only`, no I/O, no clock, no words of
 * its own; what the mark's thread says about the topic comes back as
 * {@link ImportNote}s the service puts in the importer's language.
 *
 * | BCF | Ours |
 * |---|---|
 * | `Topic/@Guid` | `source_topic_guid` (a UUIDv5 of it when it is no UUID) |
 * | `Title`, `Description` | `body`: the title, then the description; a description that starts with the title (our own export) is the body |
 * | `@TopicType` | `kind`: ours (Hint, Question, Defect), else {@link KIND_WORDS}, else hint |
 * | `@TopicStatus` | `status`: ours (Open, Resolved, Dismissed), else {@link STATUS_WORDS}, else open |
 * | `AssignedTo` | the Zuständige, when the email is someone who may answer (the service decides) |
 * | `DueDate` | `due_on`, its calendar day as written |
 * | `CreationAuthor`, `CreationDate` | a line in the thread: the importer sets the mark |
 * | `Comment` | a reply each |
 *
 * Whatever does not map exactly is said in the thread, never dropped quietly:
 * a type or status of the other tool's vocabulary, an assignee who cannot be
 * one, a date that does not read, a text cut to fit.
 */

import { MAX_ANNOTATION_BODY, type AnnotationKind, type AnnotationStatus } from '@/lib/annotations/types'
import { uuidV5 } from './bcf'
import { BCF3_TOPIC_STATUSES, BCF3_TOPIC_TYPES } from './bcf3-build'

/**
 * Namespace for the guid of a topic whose own Guid is no UUID (a writer that
 * does not follow the schema). A fixed constant: changing it would import
 * every such topic again.
 */
const FOREIGN_GUID_NAMESPACE = '3b0e6f2a-9d14-4c7e-8f51-2a6c9e0d7b48'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The key a topic is remembered by on a document: its Guid, lowercase, or a UUIDv5 of whatever the writer put there. */
export const topicKey = (guid: string): string => (UUID.test(guid.trim()) ? guid.trim().toLowerCase() : uuidV5(FOREIGN_GUID_NAMESPACE, guid.trim()))

/** Lowercase, no spaces, hyphens or underscores: „In Progress“, `in_progress` and `InProgress` are one word. */
const word = (value: string): string => value.normalize('NFC').toLocaleLowerCase('de').replace(/[\s_-]+/g, '')

/**
 * Other tools' TopicTypes, by the kind they mean. A coordination tool's
 * vocabulary is its own (BIMcollab: Issue, Clash, Request; Solibri: Issue,
 * Remark); these are the common ones and their German forms.
 */
export const KIND_WORDS: Readonly<Record<AnnotationKind, readonly string[]>> = {
  defect: ['defect', 'issue', 'error', 'clash', 'fault', 'problem', 'failure', 'conflict', 'mangel', 'fehler', 'kollision'],
  question: ['question', 'request', 'rfi', 'inquiry', 'query', 'frage', 'anfrage', 'rückfrage'],
  hint: ['hint', 'remark', 'comment', 'info', 'information', 'note', 'hinweis', 'anmerkung'],
}

/** Other tools' TopicStatuses, by the status they mean. */
export const STATUS_WORDS: Readonly<Record<Exclude<AnnotationStatus, 'proposed'>, readonly string[]>> = {
  open: ['open', 'opened', 'new', 'active', 'inprogress', 'assigned', 'reopened', 'pending', 'offen', 'inbearbeitung'],
  resolved: ['resolved', 'closed', 'done', 'fixed', 'completed', 'complete', 'solved', 'erledigt', 'gelöst', 'geschlossen'],
  dismissed: ['dismissed', 'rejected', 'invalid', 'wontfix', 'ignored', 'cancelled', 'canceled', 'verworfen', 'abgelehnt'],
}

/** A value read by the vocabulary, and whether it was one of ours exactly (else the thread names the file's word). */
export interface Mapped<T> {
  value: T
  exact: boolean
}

function lookup<T extends string>(raw: string | null, ours: Readonly<Record<T, string>>, words: Readonly<Record<T, readonly string[]>>, fallback: T): Mapped<T> {
  if (!raw) return { value: fallback, exact: false }
  const key = word(raw)
  const own = (Object.keys(ours) as T[]).find((value) => word(ours[value]) === key)
  if (own) return { value: own, exact: true }
  const near = (Object.keys(words) as T[]).find((value) => words[value].includes(key))
  return { value: near ?? fallback, exact: false }
}

export const kindOf = (topicType: string | null): Mapped<AnnotationKind> => lookup(topicType, BCF3_TOPIC_TYPES, KIND_WORDS, 'hint')

export const statusOf = (topicStatus: string | null): Mapped<Exclude<AnnotationStatus, 'proposed'>> =>
  lookup(topicStatus, BCF3_TOPIC_STATUSES, STATUS_WORDS, 'open')

/** The calendar day of an `xs:dateTime` (or a bare date) as written, or null when it is none. */
export function dueOnOf(dueDate: string | null): string | null {
  const day = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(dueDate?.trim() ?? '')?.[1]
  if (!day) return null
  const parsed = new Date(`${day}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(day) ? day : null
}

/** A text cut to `max` characters (by code point), ending in „…“ when it was cut. */
export function clip(text: string, max: number): { text: string; cut: boolean } {
  const chars = Array.from(text.trim())
  if (chars.length <= max) return { text: chars.join(''), cut: false }
  return { text: `${chars.slice(0, max - 1).join('').trimEnd()}…`, cut: true }
}

/**
 * The mark's text: the title, then the description. Our own export writes the
 * whole body as the description when it is longer than its first line, so a
 * description that starts with the title is the body already.
 */
export function bodyOf(title: string | null, description: string | null, untitled: string): { body: string; cut: boolean } {
  const head = title?.trim() ?? ''
  const rest = description?.trim() ?? ''
  // A title our export cut („…“) is still the start of the description.
  const start = head.endsWith('…') ? head.slice(0, -1) : head
  const joined = !rest ? head : !start || rest.startsWith(start) ? rest : `${head}\n\n${rest}`
  const { text, cut } = clip(joined || untitled, MAX_ANNOTATION_BODY)
  return { body: text, cut }
}

/** A short form of the title for the import's report. */
export const reportTitle = (title: string | null): string | null => (title ? clip(title, 120).text : null)

/** One line the import adds to a mark's thread: a message key of `bim.marks.import.note` and its values. */
export interface ImportNote {
  key: string
  values?: Record<string, string | number>
}
