/**
 * The E-Mail-Eingang's door to the API, as one object the components take.
 *
 * Every call is the typed client's (`adapters/api/inbound-mail-client.ts`,
 * ADR-0055): this only gathers them, so a component can be handed a fixture
 * client in a spec or a `/dev` preview and render the real thing over it.
 *
 * `follow` and `unfollow` belong to the E-Mail-Verlauf (`mail-thread-follow`,
 * `mail-thread-unfollow`), so they are its client's
 * (`adapters/api/mail-thread-client.ts`); the E-Mail-Eingang only needs to
 * know that they happened.
 */

import {
  createInboundMailAddress,
  deleteInboundMailAddress,
  dismissInboundMails,
  fileInboundMails,
  getInboundMail,
  getInboundMailAddress,
  getInboundMailText,
  inboundMailOriginalUrl,
  inboundMailPartContentUrl,
  listInboundMails,
  restoreInboundMail,
  rotateInboundMailAddress,
} from '@/adapters/api/inbound-mail-client'
import { followMailThread, listMailThreads, unfollowMailThread } from '@/adapters/api/mail-thread-client'
import type {
  DismissInboundMailsBody,
  FileInboundMailsBody,
  InboundMailAddressView,
  InboundMailDecisionResultView,
  InboundMailListQuery,
  InboundMailListView,
  InboundMailTextView,
  InboundMailView,
} from '@/lib/inbound-mail/inbound-mail-wire'
import type { MailThreadFollowBody, MailThreadSummaryView } from '@/lib/mail-thread/mail-thread-wire'

export interface InboundMailClient {
  list(projectId: string, query?: Partial<InboundMailListQuery>, signal?: AbortSignal): Promise<InboundMailListView>
  get(projectId: string, mailId: string, signal?: AbortSignal): Promise<InboundMailView>
  text(projectId: string, mailId: string, signal?: AbortSignal): Promise<InboundMailTextView>
  file(projectId: string, body: FileInboundMailsBody): Promise<InboundMailDecisionResultView>
  dismiss(projectId: string, body: DismissInboundMailsBody): Promise<{ mails: InboundMailView[] }>
  restore(projectId: string, mailId: string): Promise<InboundMailView>
  /** „Diesem E-Mail-Verlauf folgen“ (D31): the person's standing decision for one thread. */
  follow(projectId: string, threadId: string, body?: MailThreadFollowBody): Promise<void>
  /** Undo a follow just made (the toast's „Rückgängig“). */
  unfollow(projectId: string, threadId: string): Promise<void>
  /** The thread a document is, to follow a thread the text just started. */
  threadOfDocument(projectId: string, documentId: string): Promise<MailThreadSummaryView | null>
  partContentUrl(projectId: string, mailId: string, partId: string): string
  originalUrl(projectId: string, mailId: string): string
}

export interface InboundMailAddressClient {
  get(projectId: string, signal?: AbortSignal): Promise<InboundMailAddressView>
  create(projectId: string): Promise<InboundMailAddressView>
  rotate(projectId: string): Promise<InboundMailAddressView>
  remove(projectId: string): Promise<InboundMailAddressView>
}

export const inboundMailClient: InboundMailClient = {
  list: listInboundMails,
  get: getInboundMail,
  text: getInboundMailText,
  file: fileInboundMails,
  dismiss: dismissInboundMails,
  restore: restoreInboundMail,
  follow: async (projectId, threadId, body) => {
    await followMailThread(projectId, threadId, body)
  },
  unfollow: async (projectId, threadId) => {
    await unfollowMailThread(projectId, threadId)
  },
  threadOfDocument: async (projectId, documentId) => (await listMailThreads(projectId, { documentId, limit: 1 })).items[0] ?? null,
  partContentUrl: inboundMailPartContentUrl,
  originalUrl: inboundMailOriginalUrl,
}

export const inboundMailAddressClient: InboundMailAddressClient = {
  get: getInboundMailAddress,
  create: createInboundMailAddress,
  rotate: rotateInboundMailAddress,
  remove: deleteInboundMailAddress,
}
