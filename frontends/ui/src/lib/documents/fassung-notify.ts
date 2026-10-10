/**
 * Telling people about a new Fassung (CONTEXT.md „Fassung", ADR-0054, ADR-0097).
 *
 * Two events make a document newer: a person confirms that another document
 * replaces it (`PUT /api/documents/{id}/fassung`, `./fassung-service`), or a new
 * version is published under its own name (the `upload` and `publish`
 * transitions in `./lifecycle`, and — for a person's upload, which is held until
 * its bytes are screened — the moment screening lets it through,
 * `upload-batches/settle`). Both end here, in one `document.new_fassung` inbox
 * item per recipient.
 *
 * ## Who hears
 *
 * The people assigned to the OLDER document (ADR-0047) and its uploader, minus
 * the person who made the change: nobody needs telling about their own gesture.
 * Assignment is not access, so the list is then cut to those who may open BOTH
 * documents: project membership and the folder each is filed in, or
 * organization membership for the Büroablage. The row names the older document
 * and, for another name, the newer one, so a recipient who may not read either
 * must not receive it.
 *
 * ## A held document never notifies
 *
 * Both documents are re-read with the screened-only reader
 * (`documentVisibleTo`, ADR-0086) before anything is written. A held upload is
 * its uploader's and the reviewers' alone, and the row would carry its name and,
 * through the change summary, what it holds, to people who may not know it
 * exists. When the document passes screening later the settle hook calls again.
 *
 * ## Told once
 *
 * A recipient who already holds the item is skipped, not folded. The settle hook
 * can see the same document settle again (a re-read, a retry), and folding would
 * mark an item they had read unread each time.
 *
 * ## It never fails its caller
 *
 * {@link announceNewFassung} is detached and logs. The link is stored and the
 * version is published whether or not anyone could be told.
 */

import 'server-only'
import { listAssignmentsForResources } from '@/lib/assignments/repository'
import { filterUsersWhoMayReadFolder } from '@/lib/authz/folder-access'
import { resolveSubjectMembership, userHoldsProjectPermission } from '@/lib/authz/project-membership'
import type { Document } from '@/lib/db/schema'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { recipientsHoldingGroup } from '@/lib/inbox/repository'
import { emitInboxItems } from '@/lib/inbox/service'
import { collectionFileRef } from './collection-file-ref'
import { SCREENED_ONLY } from './document-reader'
import { documentDisplayName, splitDocumentName, type NamedDocument } from './display-name'
import { readFassungNames, refreshCollectionFiles } from './reconcile-status'
import { findDocumentInOrg, findFassungCounterparts } from './repository'
import { findPreviousVersion, findPublishedVersion } from './version-repository'

/** The longest first line of a change summary the row carries. */
const SUMMARY_LINE_MAX = 200

/** The most documents one settle looks at; the rest are caught by the next read. */
const SETTLE_LOOKUP_LIMIT = 50

export interface NewFassungAnnouncement {
  organizationId: string
  /** Whoever made the change. Never told. `null` when no person did. */
  actorUserId: string | null
  /** The document that is new: where the row opens. */
  newerId: string
  /** The document that was followed. The same id as `newerId` for a same-name version. */
  olderId: string
  /**
   * The new version, for a same-name Fassung. It anchors the item, so two
   * versions of one document are two rows. Absent for a confirmed link, which
   * anchors on the older document.
   */
  versionId?: string | null
  /** People who uploaded the bytes that were replaced, beside the older document's own uploader. */
  previousUploaderIds?: readonly (string | null | undefined)[]
  /** The change summary Piloti wrote, when there is one; only its first line is sent. */
  changeSummary?: string | null
}

/**
 * The first line of a change summary that says something, without list or
 * heading markers. Null for nothing to say.
 */
export function firstSummaryLine(summary: string | null | undefined): string | null {
  for (const raw of (summary ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, '').trim()
    if (line) return line.length > SUMMARY_LINE_MAX ? `${line.slice(0, SUMMARY_LINE_MAX - 1).trimEnd()}…` : line
  }
  return null
}

/**
 * A document's name as the row says it: the name people see, without the
 * file's extension. „Grundriss EG Index B.pdf" in a sentence reads as a file,
 * and the row is about a document. Only the extension of the stored FILE name
 * is taken off, so a label such as „Stand 14.08.2026" keeps its digits.
 */
function nameWithoutExtension(document: NamedDocument): string {
  const name = documentDisplayName(document)
  const { extension } = splitDocumentName(document.filename)
  if (extension === '' || !name.toLowerCase().endsWith(extension.toLowerCase())) return name
  const stem = name.slice(0, -extension.length).trimEnd()
  return stem === '' ? name : stem
}

/**
 * The names the row carries: the document followed and, for another name, the
 * newer one. Without extensions, unless the two names would then read the same
 * („Grundriss.pdf" replaced by „Grundriss.dwg"), where the extension is the
 * only thing telling them apart. Pure.
 */
export function fassungRowNames(follow: NamedDocument, newer: NamedDocument | null): { subject: string; related?: string } {
  if (!newer) return { subject: nameWithoutExtension(follow) }
  const subject = nameWithoutExtension(follow)
  const related = nameWithoutExtension(newer)
  if (subject.toLowerCase() === related.toLowerCase()) {
    return { subject: documentDisplayName(follow), related: documentDisplayName(newer) }
  }
  return { subject, related }
}

/**
 * The people a new Fassung is announced to, before anyone's access is asked:
 * the older document's assignees and uploaders, once each, minus the actor.
 * Pure, so the rule is testable without a database.
 */
export function fassungRecipients(input: {
  assigneeIds: readonly string[]
  uploaderIds: readonly (string | null | undefined)[]
  actorUserId: string | null
}): string[] {
  const everyone = [...input.assigneeIds, ...input.uploaderIds]
  return [...new Set(everyone.filter((id): id is string => Boolean(id) && id !== input.actorUserId))]
}

/** Which of `userIds` may open this document now. Fails closed per person. */
async function peopleWhoMayOpen(organizationId: string, document: Document, userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  if (document.scope === 'archiv') {
    const members = await Promise.all(
      userIds.map(async (userId) => ((await resolveSubjectMembership(organizationId, userId)) ? userId : null)),
    )
    return new Set(members.filter((userId): userId is string => userId !== null))
  }
  if (document.scope !== 'project' || !document.projectId) return new Set()
  const projectId = document.projectId
  const inProject = await Promise.all(
    userIds.map(async (userId) =>
      (await userHoldsProjectPermission({ organizationId }, projectId, userId, 'project:view')) ? userId : null,
    ),
  )
  return filterUsersWhoMayReadFolder(
    organizationId,
    projectId,
    document.folderId,
    inProject.filter((userId): userId is string => userId !== null),
  )
}

/**
 * Write the items. Returns how many people were told.
 *
 * Throws on a failed read or write; callers that must not fail use
 * {@link announceNewFassung}.
 */
export async function notifyNewFassung(announcement: NewFassungAnnouncement): Promise<number> {
  const { organizationId, newerId, olderId } = announcement
  const sameDocument = newerId === olderId
  const [newer, older] = await Promise.all([
    findDocumentInOrg(newerId, organizationId, SCREENED_ONLY),
    sameDocument ? null : findDocumentInOrg(olderId, organizationId, SCREENED_ONLY),
  ])
  const follow = sameDocument ? newer : older
  // Held, gone or not in this organization: nothing is said about it.
  if (!newer || !follow) return 0
  if (newer.lifecycle !== 'active' || newer.scope === 'session' || follow.scope === 'session') return 0

  const assignments = await listAssignmentsForResources(organizationId, 'document', [follow.id])
  const candidates = fassungRecipients({
    assigneeIds: assignments.map((row) => row.subjectUserId),
    uploaderIds: [follow.createdBy, ...(announcement.previousUploaderIds ?? [])],
    actorUserId: announcement.actorUserId,
  })
  if (candidates.length === 0) return 0

  const mayOpenNewer = await peopleWhoMayOpen(organizationId, newer, candidates)
  const mayOpenBoth = sameDocument
    ? mayOpenNewer
    : await peopleWhoMayOpen(organizationId, follow, [...mayOpenNewer])
  if (mayOpenBoth.size === 0) return 0

  const anchorId = announcement.versionId ?? follow.id
  const groupKey = inboxGroupKey('document.new_fassung', 'document', newer.id, anchorId)
  const already = await recipientsHoldingGroup(organizationId, groupKey, [...mayOpenBoth])
  const told = [...mayOpenBoth].filter((userId) => !already.has(userId))
  if (told.length === 0) return 0

  const excerpt = firstSummaryLine(announcement.changeSummary)
  await emitInboxItems(
    told.map((recipientUserId) => ({
      organizationId,
      recipientUserId,
      type: 'document.new_fassung' as const,
      resourceType: 'document' as const,
      resourceId: newer.id,
      anchorId,
      actorUserId: announcement.actorUserId,
      groupKey,
      // A second name only when there is one: a same-name version is the
      // same document, and the title reads without it. Who made the change is
      // `actorUserId`, resolved to a name when the inbox is read.
      payload: {
        ...fassungRowNames(follow, sameDocument ? null : newer),
        ...(excerpt ? { excerpt } : {}),
      },
    })),
  )
  return told.length
}

/**
 * {@link notifyNewFassung}, detached: the caller carries on at once and a
 * failure is logged, never raised. The one call a confirmed link, a published
 * version and a settled upload make.
 */
export function announceNewFassung(announcement: NewFassungAnnouncement): Promise<void> {
  return notifyNewFassung(announcement).then(
    () => undefined,
    (error: unknown) => {
      console.warn(`[fassung-notify] could not announce the new Fassung of ${announcement.olderId}:`, error)
    },
  )
}

/** The same-name half: a published version that is not the document's first. */
async function announceSettledVersion(organizationId: string, document: Document): Promise<void> {
  const version = await findPublishedVersion(document.id, organizationId)
  if (!version || version.versionNumber < 2) return
  const previous = await findPreviousVersion(document.id, organizationId, version.versionNumber)
  await announceNewFassung({
    organizationId,
    actorUserId: version.createdBy,
    newerId: document.id,
    olderId: document.id,
    versionId: version.id,
    previousUploaderIds: [previous?.createdBy],
  })
}

/**
 * The cross-name half: the older documents the backend lists as replaced by
 * this one. A link written at ingestion (the upload dialog's confirmation, a
 * Fassung Piloti read from the title block) exists before the job finishes, so
 * the moment the document is readable is the first moment anyone can be told.
 * Names resolve to screened documents of the SAME collection; who may open
 * which is cut by {@link notifyNewFassung}.
 */
async function announceSettledLinks(organizationId: string, document: Document): Promise<void> {
  const ref = collectionFileRef(document)
  const names = ref ? await readFassungNames(ref) : null
  if (!names || names.supersedes.length === 0) return
  const olders = await findFassungCounterparts(organizationId, document.collectionName, names.supersedes, SCREENED_ONLY)
  for (const older of olders) {
    if (older.id === document.id) continue
    await announceNewFassung({
      organizationId,
      actorUserId: document.createdBy,
      newerId: document.id,
      olderId: older.id,
      changeSummary: names.change?.text ?? null,
    })
  }
}

/**
 * Announce the Fassungen among documents that just came to rest.
 *
 * A person's upload is held until its bytes are screened, so the `upload`
 * transition cannot tell anyone: the document it replaces is not yet readable
 * by them. This is the other half, called by the settle hook (which never
 * throws): for each document that is screened now, the people who followed
 * what it replaces are told, whether it replaced a version under its own name
 * or an older document under another (a link already written at ingestion).
 * A Piloti document (its publish transition announces it) and a document seen
 * before (the recipient already holds the item) say nothing.
 *
 * Bounded by {@link SETTLE_LOOKUP_LIMIT}. The collection listings are read
 * fresh once per collection, because the cached one may predate the link.
 */
export async function announceSettledVersions(organizationId: string, documentIds: readonly string[]): Promise<void> {
  const settled: Document[] = []
  for (const documentId of documentIds.slice(0, SETTLE_LOOKUP_LIMIT)) {
    const document = await findDocumentInOrg(documentId, organizationId, SCREENED_ONLY)
    if (document && document.authoredBy === 'user' && document.scope !== 'session') settled.push(document)
  }
  const collections = new Set(settled.filter((document) => collectionFileRef(document)).map((d) => d.collectionName))
  await Promise.all([...collections].map((collection) => refreshCollectionFiles(collection).catch(() => undefined)))
  for (const document of settled) {
    await announceSettledVersion(organizationId, document)
    await announceSettledLinks(organizationId, document)
  }
}
