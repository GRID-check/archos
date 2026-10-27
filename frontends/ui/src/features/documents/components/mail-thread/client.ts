/**
 * The „E-Mails“ tab's door to the API, as one object the components take.
 *
 * Every call is a typed client's (`adapters/api/mail-thread-client.ts` for the
 * thread, `lib/documents/lifecycle-client.ts` for the thread document's
 * Fassungen, `adapters/api/folder-access-client.ts` for the followers' names),
 * gathered here so a spec or the `/dev/mail-thread` preview hands the real
 * organism a fixture client and renders the real thing over it (the same
 * shape as the E-Mail-Eingang's `InboundMailClient`).
 */

import {
  detachMailThreadEntry,
  followMailThread,
  getMailThread,
  listMailThreads,
  mailThreadEntryOriginalUrl,
  unfollowMailThread,
} from '@/adapters/api/mail-thread-client'
import { listProjectPeople, type ProjectPerson } from '@/adapters/api/folder-access-client'
import { downloadFetched, type FetchedDownload } from '@/lib/browser-download'
import { documentLifecycleClient } from '@/lib/documents/lifecycle-client'
import type { DocumentVersionDiffResponse, DocumentVersionListResponse } from '@/lib/documents/lifecycle-types'
import type {
  MailThreadEntryDetachBody,
  MailThreadEntryDetachResultView,
  MailThreadFollowBody,
  MailThreadFollowResultView,
  MailThreadListQuery,
  MailThreadListView,
  MailThreadSummaryView,
  MailThreadUnfollowResultView,
  MailThreadView,
} from '@/lib/mail-thread/mail-thread-wire'

export interface MailThreadClient {
  /** The thread a document is, or null: the document is no E-Mail-Verlauf, or the reader may not see its thread. */
  ofDocument(projectId: string, documentId: string, signal?: AbortSignal): Promise<MailThreadSummaryView | null>
  get(projectId: string, threadId: string, signal?: AbortSignal): Promise<MailThreadView>
  /** The project's threads, for „In anderen E-Mail-Verlauf verschieben“. */
  list(projectId: string, query?: Partial<MailThreadListQuery>): Promise<MailThreadListView>
  follow(projectId: string, threadId: string, body?: MailThreadFollowBody): Promise<MailThreadFollowResultView>
  unfollow(projectId: string, threadId: string, options?: { userId?: string }): Promise<MailThreadUnfollowResultView>
  detach(projectId: string, threadId: string, entryId: string, body: MailThreadEntryDetachBody): Promise<MailThreadEntryDetachResultView>
  /** Download one message's original `.eml`: scanned whole on the request, refused 409 `original_not_clean` or `gone`. */
  downloadOriginal(projectId: string, threadId: string, entryId: string): Promise<FetchedDownload>
  /** The thread document's Fassungen, for „Vergleichen“ and the detach confirmation. */
  versions(documentId: string): Promise<DocumentVersionListResponse>
  diff(documentId: string, fromVersionId: string, toVersionId: string): Promise<DocumentVersionDiffResponse>
  /** The project's people, so a manager reads the followers by name. Needs `project:manage`, which `managesFollows` says. */
  people(projectId: string): Promise<ProjectPerson[]>
}

export const mailThreadClient: MailThreadClient = {
  ofDocument: async (projectId, documentId, signal) =>
    (await listMailThreads(projectId, { documentId, limit: 1 }, signal)).items[0] ?? null,
  get: getMailThread,
  list: (projectId, query) => listMailThreads(projectId, query),
  follow: followMailThread,
  unfollow: unfollowMailThread,
  detach: detachMailThreadEntry,
  downloadOriginal: (projectId, threadId, entryId) =>
    downloadFetched(mailThreadEntryOriginalUrl(projectId, threadId, entryId), 'original.eml'),
  versions: (documentId) => documentLifecycleClient.listVersions(documentId),
  diff: (documentId, from, to) => documentLifecycleClient.diff(documentId, from, to),
  people: listProjectPeople,
}
