/**
 * A coordination BCF file onto a model: each topic becomes an ordinary
 * Anmerkung with a viewpoint (F6, `docs/roadmap/model-collaboration.md`). Not a
 * BCF viewer: what comes in is the office's own mark, with its inbox row, its
 * Zuständige, its Frist and its thread.
 *
 * ## The gate
 *
 * The same one setting a mark has: `getAccessibleDocument(…, 'write')` on a
 * document of a shelf that carries Anmerkungen, then `getModelForDocument`
 * (the IFC switch, `documentVisibleTo`) and a model that is `ready`, because
 * its element list is what the selection is checked against. The bytes are read
 * by `./bcf-archive.ts` and `./bcf-xml.ts`, which refuse the whole file for an
 * unsafe archive; a topic that cannot be read fails alone.
 *
 * ## Who is who
 *
 * The importer sets every mark (`created_by`): they brought it into the
 * office's record. The topic's author and date are the first line of the
 * thread's import note. `AssignedTo` becomes the Zuständige when it is the email
 * of someone who may answer the mark (who may write the document,
 * `isAssignable`'s rule in `lib/annotations/service.ts`); otherwise the note
 * names them. A comment is a reply by its author when the email is someone who
 * may open the document, at the comment's own date; otherwise the importer's,
 * with the author's name and date in its text.
 *
 * ## Once per topic
 *
 * The topic's Guid is kept (`source_topic_guid`, migration 0196) and unique per
 * document: importing the file again, or next round's file, skips what is here.
 * Every mark of one import shares `import_batch_id`, the unit a later triage
 * runs over. A topic without a viewpoint is skipped and reported; a later step
 * frames it from the elements' stored boxes (F4's `frameViewpoint`).
 *
 * What a person learns: the document's people one counted row
 * (`onMarksSet`), each new Zuständige theirs (`onAssigneeChanged`), the room a
 * re-read; an audit event (`document.annotations.imported`) and a product
 * event (`annotations_imported`) with counts, never a word of a topic.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { getLocale, getTranslations } from '@/i18n/server'
import { bimCopy } from '@/i18n/namespaces/bim'
import type { Translator } from '@/i18n/translate'
import { captureServer } from '@/lib/analytics/posthog-server'
import { BadRequestError, UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema/documents'
import { getAccessibleDocument } from '@/lib/documents/access'
import { mayOpenDocument, mayWriteDocument } from '@/lib/documents/may-open'
import { memberReader } from '@/lib/documents/visibility'
import { OFFICE_TIME_ZONE } from '@/lib/format'
import { onAssigneeChanged, onMarksSet } from '@/lib/annotations/attention'
import { importedTopicGuids, insertImportedMark, TopicImportedTwiceError, type ImportedReply } from '@/lib/annotations/import-repository'
import { AnnotationLimitReachedError } from '@/lib/annotations/numbering'
import { MAX_ANNOTATION_BODY, MAX_REPLIES_PER_ANNOTATION } from '@/lib/annotations/types'
import { viewpointValues } from '@/lib/annotations/viewpoint-place'
import { findMissingElements } from '@/lib/annotations/viewpoint-repository'
import { discardSnapshot, putSnapshot, snapshotUploadOf, type SnapshotUpload } from '@/lib/annotations/viewpoint-snapshot'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { BcfArchiveError, readBcfArchive } from './bcf-archive'
import { bodyOf, clip, dueOnOf, kindOf, reportTitle, statusOf, topicKey, type ImportNote } from './bcf-import-map'
import type { BcfImportResult } from './bcf-import-wire'
import { isReadableVersion, readBcf, type BcfTopicRead } from './bcf-read'
import { getModelForDocument } from './model-service'

/** The bytes and name of the uploaded file. */
export interface BcfUpload {
  name: string
  bytes: Uint8Array
}

/** Who in the office an email names, among those the import may make an author or a Zuständige. */
interface People {
  /** Email (lowercase) to user id: who may answer a mark on this document. */
  assignable: ReadonlyMap<string, string>
  /** Email (lowercase) to user id: who may open the document, so may have written in its thread. */
  readers: ReadonlyMap<string, string>
}

interface Context {
  session: AuthorizedSession
  doc: Document
  modelId: string
  /** The model's element list is truncated: a missing GlobalId may be in the part not stored, so none is dropped. */
  checkElements: boolean
  people: People
  t: Translator
  date: (value: Date) => string
  fileName: string
  batchId: string
  now: number
}

const emailKey = (value: string | null): string => (value ?? '').trim().toLowerCase()

/** The directory's people by email, split by what each may do on this document; one read of each rule. */
async function peopleOf(session: AuthorizedSession, doc: Document, emails: readonly string[]): Promise<People> {
  const wanted = new Set(emails.map(emailKey).filter((email) => email.includes('@')))
  if (wanted.size === 0) return { assignable: new Map(), readers: new Map() }
  const directory = [...(await loadOrganizationDirectory(session.organizationId)).values()]
  const named = directory.filter((person) => wanted.has(emailKey(person.email)))
  const ids = named.map((person) => person.userId)
  const [writers, readers] = await Promise.all([mayWriteDocument(session, doc, ids), mayOpenDocument(session, doc, ids)])
  const byEmail = (allowed: ReadonlySet<string>) =>
    new Map(named.filter((person) => allowed.has(person.userId)).map((person) => [emailKey(person.email), person.userId]))
  return { assignable: byEmail(writers), readers: byEmail(readers) }
}

const say = (t: Translator, note: ImportNote): string => t(`marks.import.note.${note.key}`, note.values)

/** The topic's own lines in the import note: where it came from, and whatever did not map exactly. */
function topicNotes(topic: BcfTopicRead, context: Context, assigned: boolean): ImportNote[] {
  const kind = kindOf(topic.topicType)
  const status = statusOf(topic.topicStatus)
  const notes: ImportNote[] = [{ key: 'origin', values: { file: context.fileName } }]
  if (topic.creationAuthor) {
    notes.push(
      topic.creationDate
        ? { key: 'authorDate', values: { author: topic.creationAuthor, date: context.date(topic.creationDate) } }
        : { key: 'author', values: { author: topic.creationAuthor } }
    )
  }
  if (topic.topicType && !kind.exact) notes.push({ key: 'type', values: { value: topic.topicType } })
  if (topic.topicStatus && !status.exact) notes.push({ key: 'status', values: { value: topic.topicStatus } })
  if (topic.assignedTo && !assigned) notes.push({ key: 'assignee', values: { value: topic.assignedTo } })
  if (topic.dueDate && !dueOnOf(topic.dueDate)) notes.push({ key: 'due', values: { value: topic.dueDate } })
  return notes
}

/** The view's lines: what was cut to fit, and the elements this model lacks. */
function viewNotes(topic: BcfTopicRead, missing: number): ImportNote[] {
  const cuts = topic.view?.cuts
  if (!cuts) return []
  const notes: ImportNote[] = []
  if (missing > 0) notes.push({ key: 'missing', values: { count: missing } })
  if (cuts.selection > 0) notes.push({ key: 'selection', values: { count: cuts.selection } })
  if (cuts.planes > 0) notes.push({ key: 'planes', values: { count: cuts.planes } })
  if (cuts.visibility) notes.push({ key: 'visibility' })
  if (cuts.snapshot) notes.push({ key: `snapshot.${cuts.snapshot}` })
  return notes
}

/** The thread: one reply per comment, then the import note, each dated so the order holds. */
function repliesOf(topic: BcfTopicRead, context: Context, notes: ImportNote[]): ImportedReply[] {
  const room = MAX_REPLIES_PER_ANNOTATION - 1
  const comments = topic.comments.slice(0, room)
  if (topic.comments.length > room) notes.push({ key: 'repliesCut', values: { count: topic.comments.length - room } })
  const replies = comments.map((comment, index): ImportedReply => {
    const author = context.people.readers.get(emailKey(comment.author))
    const when = comment.date && comment.date.getTime() <= context.now ? comment.date : new Date(context.now + index)
    const said = clip(comment.text, MAX_ANNOTATION_BODY)
    if (author) return { body: said.text, createdBy: author, createdAt: when }
    const name = comment.author ?? context.t('marks.import.unknownAuthor')
    const text = comment.date
      ? context.t('marks.import.replyByOn', { author: name, date: context.date(comment.date), text: comment.text })
      : context.t('marks.import.replyBy', { author: name, text: comment.text })
    return { body: clip(text, MAX_ANNOTATION_BODY).text, createdBy: context.session.userId, createdAt: when }
  })
  const note = clip(notes.map((line) => say(context.t, line)).join('\n'), MAX_ANNOTATION_BODY).text
  replies.push({ body: note, createdBy: context.session.userId, createdAt: new Date(context.now + comments.length + 1) })
  return replies
}

type Outcome =
  | { kind: 'imported'; entry: BcfImportResult['imported'][number]; body: string; assignee: string | null; dueOn: string | null; open: boolean }
  | { kind: 'failed'; entry: BcfImportResult['failed'][number] }

/** One topic with a view, written as a mark; its snapshot first, deleted again when the mark is not written. */
async function importTopic(topic: BcfTopicRead & { view: NonNullable<BcfTopicRead['view']> }, key: string, context: Context): Promise<Outcome> {
  const { session, doc } = context
  const view = topic.view
  const selection = view.viewpoint.components.selection.globalIds
  const missing = context.checkElements
    ? new Set(await findMissingElements(session.organizationId, context.modelId, selection, memberReader(session.userId)))
    : new Set<string>()
  const assignee = context.people.assignable.get(emailKey(topic.assignedTo)) ?? null
  const { body, cut } = bodyOf(topic.title, topic.description, context.t('marks.import.untitled'))
  const notes = [...topicNotes(topic, context, assignee !== null), ...viewNotes(topic, missing.size)]
  if (cut) notes.push({ key: 'bodyCut', values: { max: MAX_ANNOTATION_BODY } })
  const id = randomUUID()
  const snapshot: SnapshotUpload | null = view.snapshot
    ? snapshotUploadOf(doc, id, view.snapshot.contentType, Buffer.from(view.snapshot.bytes))
    : null
  const components = { ...view.viewpoint.components, selection: { globalIds: selection.filter((globalId) => !missing.has(globalId)) } }
  const status = statusOf(topic.topicStatus).value
  const dueOn = dueOnOf(topic.dueDate)
  const replies = repliesOf(topic, context, notes)
  if (snapshot) await putSnapshot(snapshot)
  try {
    const row = await insertImportedMark({
      organizationId: session.organizationId,
      documentId: doc.id,
      versionId: doc.publishedVersionId ?? null,
      createdBy: session.userId,
      viewpoint: viewpointValues(id, { ...view.viewpoint, components }, snapshot),
      mark: { kind: kindOf(topic.topicType).value, body, mentions: [], basis: null, assigneeUserId: assignee, dueOn, status },
      sourceTopicGuid: key,
      importBatchId: context.batchId,
      replies,
    })
    return {
      kind: 'imported',
      entry: { topic: topic.guid, annotationId: row.id, number: row.number, assigned: assignee !== null },
      body: row.body,
      assignee,
      dueOn,
      open: status === 'open',
    }
  } catch (error) {
    if (snapshot) await discardSnapshot(snapshot)
    throw error
  }
}

/** The file's bytes as topics, or the 422 that refuses the whole file. */
function readFile(upload: BcfUpload) {
  let files: Map<string, Uint8Array>
  try {
    files = readBcfArchive(upload.bytes)
  } catch (error) {
    if (error instanceof BcfArchiveError) {
      throw new UnprocessableError('This BCF file cannot be read safely.', { reason: error.reason })
    }
    throw error
  }
  const read = readBcf(files)
  if (!isReadableVersion(read.version)) {
    throw new UnprocessableError(`BCF ${read.version} is not read; 2.1 and 3.0 are.`, { reason: 'unsupported_version' })
  }
  if (read.topics.length === 0 && read.unread.length === 0 && !files.has('bcf.version')) {
    throw new UnprocessableError('This is no BCF file: it has no topics and no bcf.version.', { reason: 'not_bcf' })
  }
  return read
}

async function requireModel(session: AuthorizedSession, documentId: string): Promise<{ doc: Document; modelId: string; checkElements: boolean }> {
  const doc = await getAccessibleDocument(session, documentId, 'write')
  if (doc.scope !== 'project' && doc.scope !== 'office_shelf') throw new BadRequestError('This document cannot carry Anmerkungen.')
  const model = await getModelForDocument(session, doc.id)
  if (!model) throw new UnprocessableError('Only an IFC model takes a BCF file.', { reason: 'not_a_model' })
  if (model.status !== 'ready') {
    throw new UnprocessableError('The model is not ready yet. Import when its status is ready.', { reason: 'model_not_ready' })
  }
  return { doc, modelId: model.id, checkElements: model.summary?.truncatedAt == null }
}

/** Tell people once everything is written: a row per new Zuständige, one counted row for the document, the room. */
function tell(context: Context, created: Extract<Outcome, { kind: 'imported' }>[]): void {
  const { session, doc } = context
  if (created.length === 0) return
  const ref = { organizationId: session.organizationId, documentId: doc.id, projectId: doc.projectId ?? null }
  const mayOpen = (userIds: readonly string[]) => mayOpenDocument(session, doc, userIds)
  const quietly = (label: string, work: Promise<unknown>) =>
    void work.catch((error: unknown) => console.warn(`[bcf-import] could not ${label}:`, error))
  for (const mark of created) {
    if (!mark.assignee) continue
    quietly(
      'tell the Zuständige',
      onAssigneeChanged({
        ...ref,
        annotationId: mark.entry.annotationId,
        annotationNumber: mark.entry.number,
        actorUserId: session.userId,
        byAgent: false,
        markText: mark.body,
        previousAssigneeUserId: null,
        assigneeUserId: mark.assignee,
        open: mark.open,
        dueOn: mark.dueOn,
      })
    )
  }
  quietly(
    'tell the document’s people',
    onMarksSet({
      ...ref,
      actorUserId: session.userId,
      uploaderUserId: doc.createdBy ?? null,
      by: 'created',
      marks: created
        .filter((mark) => mark.open)
        .map((mark) => ({ id: mark.entry.annotationId, number: mark.entry.number, body: mark.body, toldOtherwise: [mark.assignee] })),
      mayOpen,
    })
  )
  quietly(
    'tell the room',
    publishToDocumentRoom(doc.id, {
      kind: 'annotations.changed',
      annotationIds: created.map((mark) => mark.entry.annotationId),
      change: 'created',
      actor: { peerId: null, userId: session.userId, name: session.name ?? session.email, kind: 'person' },
    })
  )
}

/**
 * Import a BCF file (2.1 or 3.0) onto a model this person may write: every
 * topic with a viewpoint becomes a mark; the report says what became of each.
 */
export async function importAnnotationsBcf(
  session: AuthorizedSession,
  documentId: string,
  upload: BcfUpload,
  request?: Request
): Promise<BcfImportResult> {
  const { doc, modelId, checkElements } = await requireModel(session, documentId)
  const read = readFile(upload)
  const emails = read.topics.flatMap((topic) => [topic.assignedTo ?? '', ...topic.comments.map((comment) => comment.author ?? '')])
  const [people, existing, locale, t] = await Promise.all([
    peopleOf(session, doc, emails),
    importedTopicGuids(session.organizationId, doc.id),
    getLocale(),
    getTranslations(bimCopy),
  ])
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: OFFICE_TIME_ZONE })
  const context: Context = {
    session,
    doc,
    modelId,
    checkElements,
    people,
    t,
    date: (value) => day.format(value),
    fileName: upload.name,
    batchId: randomUUID(),
    now: Date.now(),
  }
  const result: BcfImportResult = {
    batchId: context.batchId,
    version: read.version,
    topics: read.topics.length + read.unread.length,
    imported: [],
    skipped: [],
    failed: read.unread.map((entry) => ({ topic: entry.folder, title: null, reason: entry.reason })),
  }
  const created: Extract<Outcome, { kind: 'imported' }>[] = []
  const seen = new Set<string>()
  let full = false
  for (const topic of read.topics) {
    const key = topicKey(topic.guid)
    const ref = { topic: topic.guid, title: reportTitle(topic.title) }
    if (seen.has(key)) result.skipped.push({ ...ref, reason: 'duplicate_in_file' })
    else if (existing.has(key)) result.skipped.push({ ...ref, reason: 'already_imported' })
    else if (!topic.view) result.skipped.push({ ...ref, reason: 'no_viewpoint' })
    else if (full) result.failed.push({ ...ref, reason: 'limit' })
    else {
      const outcome = await importTopic({ ...topic, view: topic.view }, key, context).catch((error: unknown): Outcome | 'twice' => {
        if (error instanceof TopicImportedTwiceError) return 'twice'
        if (error instanceof AnnotationLimitReachedError) {
          full = true
          return { kind: 'failed', entry: { ...ref, reason: 'limit' } }
        }
        console.error(`[bcf-import] topic ${key} on document ${doc.id} failed:`, error)
        return { kind: 'failed', entry: { ...ref, reason: 'error' } }
      })
      if (outcome === 'twice') result.skipped.push({ ...ref, reason: 'already_imported' })
      else if (outcome.kind === 'failed') result.failed.push(outcome.entry)
      else {
        created.push(outcome)
        result.imported.push(outcome.entry)
      }
    }
    seen.add(key)
  }

  tell(context, created)
  await record(context, result, request)
  return result
}

/** The audit line and the product event: counts, the version and the batch, never a word of a topic. */
async function record(context: Context, result: BcfImportResult, request?: Request): Promise<void> {
  const { session, doc } = context
  const counts = {
    topicCount: result.topics,
    importedCount: result.imported.length,
    skippedCount: result.skipped.length,
    failedCount: result.failed.length,
    assignedCount: result.imported.filter((entry) => entry.assigned).length,
  }
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.annotations.imported',
    targetType: 'document',
    targetId: doc.id,
    metadata: { format: 'bcf', version: result.version ?? 'unknown', batchId: result.batchId, ...counts },
    request,
  })
  captureServer({
    event: 'annotations_imported',
    distinctId: session.userId,
    organizationId: session.organizationId,
    properties: {
      document_id: doc.id,
      format: 'bcf',
      version: result.version ?? 'unknown',
      topics: counts.topicCount,
      imported: counts.importedCount,
      skipped: counts.skippedCount,
      failed: counts.failedCount,
      assigned: counts.assignedCount,
      skipped_no_viewpoint: result.skipped.filter((entry) => entry.reason === 'no_viewpoint').length,
      skipped_already_imported: result.skipped.filter((entry) => entry.reason === 'already_imported').length,
    },
  })
}
