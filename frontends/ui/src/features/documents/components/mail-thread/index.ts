/**
 * The E-Mail-Verlauf in a document's preview (ADR-0137, D16, D36): the
 * „E-Mails“ tab of a thread document, and the provenance a mail gives the
 * Fassungen it brought. One import surface for the pane and the previews.
 */

export { mailThreadClient, type MailThreadClient } from './client'
export { MailOriginLine, mailEntryHref, useOpenMailOrigin } from './mail-origin-line'
export { MailProvenanceRow } from './mail-provenance-row'
export { MailThreadTab } from './mail-thread-tab'
export { MAIL_ENTRY_PARAM } from './mail-thread-model'
export { ThreadRailViews, type RailView } from './rail-views'
export { mayBeThreadDocument, useMailThreadOfDocument } from './use-mail-thread-of-document'
