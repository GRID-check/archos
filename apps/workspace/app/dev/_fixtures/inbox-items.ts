/**
 * The inbox the previews render (`/dev/inbox`, `/dev/inbox-dock`): one fixture
 * row per interesting treatment, and the `fetch` shim that serves them. One
 * copy, so the list and the dock are shown the same inbox.
 *
 * The fixtures deliberately exercise every interesting row: an unread actionable
 * mention request, a resolved one, a grouped activity row, a shared-with-you
 * row, a READ grouped row with `count: 0`, the OPERATIONAL storage-quota
 * warning (ADR-0042), a row whose type this build does not know (the runtime
 * fallback), an INERT row whose target is gone (IB-13), and the marks, Fassungen
 * and the agent's rows of the review.
 */

import type { InboxItemView } from '@/lib/inbox/types'
import { MENTIONABLE, VIEWER_ID, replyToMark, withProjects } from './inbox-rows'
import { PRODUCT_NAME } from '@/lib/brand'

// Relative to now, so „vor 4 Minuten“ reads as it would in the product rather
// than every row claiming months.
const now = Date.now()

const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()

export const ITEMS: InboxItemView[] = [
  // Platform lane: a member elsewhere in the fleet sent product feedback. The
  // reader is a platform owner; the row lives in the platform organization.
  {
    id: 'i0',
    type: 'feedback.submitted',
    state: 'unread',
    archived: false,
    read: false,
    actionable: false,
    resourceType: 'product_feedback',
    resourceId: 'f1',
    anchorId: null,
    actorName: 'Maria Huber',
    actorUserId: 'u-maria',
    count: 1,
    href: '/app/platform/feedback?report=f1',
    subject: 'Architekturbüro Nord',
    related: null,
    excerpt: 'Beim Hochladen eines 80-MB-Plans bleibt der Fortschritt bei 99 % stehen, auch nach 10 Minuten.',
    mentions: [],
    variant: null,
    answerIn: null,
    createdAt: ago(4),
    updatedAt: ago(4),
  },
  {
    id: 'i1',
    type: 'mention.requested',
    state: 'unread',
    archived: false,
    read: false,
    actionable: true,
    resourceType: 'conversation',
    resourceId: 'c1',
    anchorId: 'm-9',
    actorName: 'Anna Weber',
    actorUserId: 'u-anna',
    count: 1,
    href: '/app/projects/p1/chat?session=c1#m-9',
    subject: 'Atrium – Rauchabschnitte GK 4',
    related: null,
    excerpt:
      'Ist die Annahme richtig, dass das Atrium als eigener Brandabschnitt geführt wird? Dann bräuchten wir die Entrauchung im Kern.',
    mentions: [],
    variant: null,
    answerIn: null,
    createdAt: ago(18),
    updatedAt: ago(18),
  },
  {
    id: 'i2',
    type: 'conversation.activity',
    state: 'unread',
    archived: false,
    read: false,
    actionable: false,
    resourceType: 'conversation',
    resourceId: 'c2',
    anchorId: null,
    actorName: 'Markus Hofer',
    actorUserId: 'u-markus',
    count: 3,
    href: '/app/projects/p1/chat?session=c2',
    subject: 'Fluchtwegbreiten Bauteil Nord',
    related: null,
    excerpt: 'Die 1,20 m halten wir ein, aber der Treppenlauf im Kern B ist noch offen.',
    mentions: [],
    variant: null,
    answerIn: null,
    createdAt: ago(52),
    updatedAt: ago(52),
  },
  {
    id: 'i3',
    type: 'conversation.shared_with_you',
    state: 'read',
    archived: false,
    read: true,
    actionable: false,
    resourceType: 'conversation',
    resourceId: 'c3',
    anchorId: null,
    actorName: 'Sabine Gruber',
    actorUserId: 'u-sabine',
    count: 1,
    href: '/app/projects/p1/chat?session=c3',
    subject: 'Stellplatznachweis Wohnbau Nord',
    related: null,
    excerpt: null,
    mentions: [],
    variant: null,
    answerIn: null,
    createdAt: ago(320),
    updatedAt: ago(320),
  },
  {
    id: 'i4',
    type: 'mention.requested',
    state: 'resolved',
    archived: false,
    read: true,
    actionable: true,
    resourceType: 'conversation',
    resourceId: 'c4',
    anchorId: 'm-4',
    actorName: 'Markus Hofer',
    actorUserId: 'u-markus',
    count: 1,
    href: '/app/projects/p1/chat?session=c4#m-4',
    subject: 'Barrierefreiheit Zugang Ost',
    related: null,
    excerpt: 'Passt so – die Rampe bleibt bei 6 %.',
    mentions: [],
    variant: null,
    answerIn: null,
    createdAt: ago(1_500),
    updatedAt: ago(900),
  },
  {
    id: 'i5',
    type: 'mention.answered',
    state: 'read',
    archived: false,
    read: true,
    actionable: false,
    resourceType: 'conversation',
    resourceId: 'c5',
    anchorId: 'm-12',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/chat?session=c5#m-12',
    subject: null,
    related: null,
    excerpt: null,
    mentions: [],
    variant: null,
    answerIn: null,
    createdAt: ago(2_600),
    updatedAt: ago(2_600),
  },
  {
    /*
      The OPERATIONAL row (ADR-0042) — the one item type that is not a
      collaboration event. It has to be in the evidence because it is the only
      row with no actor (a system alert that fell back to the actor placeholder
      would invent a colleague), the only one carrying `tone: 'warning'`, and the
      only one pointing at the organization rather than a conversation. It is
      also the row a tenant WITHOUT collaboration sees on its own, so how it
      reads unaccompanied is the whole design question.
    */
    id: 'i5a',
    type: 'storage.quota_warning',
    state: 'unread',
    archived: false,
    read: false,
    actionable: false,
    resourceType: 'organization',
    resourceId: 'org-1',
    // The crossed threshold bucket, which is what makes the alert fire once per
    // crossing rather than once per sweep.
    anchorId: '80',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/organization/storage',
    // Locale-neutral token: the sentence around it is translated, the number is
    // not, so the server never formats an English sentence.
    subject: '82%',
    related: null,
    excerpt: null,
    mentions: [],
    variant: null,
    answerIn: null,
    createdAt: ago(140),
    updatedAt: ago(140),
  },
  {
    /*
      `count: 0` — a grouped row that has been READ, so nothing has arrived since.
      It is the ordinary state of every activity row a user has already opened, and
      it renders the third counted title (`titleNone`, "Neue Nachrichten"): picking
      `titleOne` for it made a group of twenty claim "1 neue Nachricht". Without a
      zero-count row in the fixture that string is unreachable, so the fix could not
      be seen.
    */
    id: 'i5b',
    type: 'conversation.activity',
    state: 'read',
    archived: false,
    read: true,
    actionable: false,
    resourceType: 'conversation',
    resourceId: 'c5b',
    anchorId: null,
    actorName: 'Anna Weber',
    actorUserId: 'u-anna',
    count: 0,
    href: '/app/projects/p1/chat?session=c5b',
    subject: 'Abstandsflächen Bauteil Süd',
    related: null,
    excerpt: null,
    mentions: [],
    variant: null,
    answerIn: null,
    createdAt: ago(2_900),
    updatedAt: ago(2_050),
  },
  {
    /*
      A row whose type this build does not know — written by a newer deploy, or read
      across a rollback. It used to index `INBOX_TYPE_PRESENTATION` to `undefined`
      and throw, taking the whole /app/inbox route down rather than costing one row.
      The fallback presentation must therefore be in the evidence: one unremarkable
      row ("Es gibt etwas Neues"), not a blank page.

      The cast is the point: the type is deliberately outside the compile-time union,
      which is exactly the situation the runtime fallback exists for.
    */
    id: 'i5c',
    type: 'conversation.summarized' as unknown as InboxItemView['type'],
    state: 'read',
    archived: false,
    read: true,
    actionable: false,
    resourceType: 'conversation',
    resourceId: 'c5c',
    anchorId: null,
    actorName: PRODUCT_NAME,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/chat?session=c5c',
    subject: 'Brandschutzkonzept Bauteil West',
    related: null,
    excerpt: null,
    mentions: [],
    variant: null,
    answerIn: null,
    createdAt: ago(3_400),
    updatedAt: ago(3_400),
  },
  {
    // Target unshared/deleted: no link, no excerpt (IB-13/IB-14).
    id: 'i6',
    type: 'conversation.activity',
    state: 'inert',
    archived: false,
    read: true,
    actionable: false,
    resourceType: 'conversation',
    resourceId: 'c6',
    anchorId: null,
    actorName: 'Klaus Berger',
    actorUserId: 'u-klaus',
    count: 2,
    href: null,
    subject: null,
    related: null,
    excerpt: null,
    mentions: [],
    variant: null,
    answerIn: null,
    createdAt: ago(4_100),
    updatedAt: ago(4_100),
  },
  // A newer Fassung of a document you follow (ADR-0099), as a sentence about
  // the person who uploaded it. The older document is the subject (without its
  // extension, as `revisionRowNames` writes it), the newer one the second name,
  // and the excerpt is the first line of what changed: the row's only body.
  // „Fassungen vergleichen" opens the newer one with the comparison open.
  {
    id: 'i-revision',
    type: 'document.new_revision',
    state: 'unread',
    archived: false,
    read: false,
    actionable: false,
    resourceType: 'document',
    resourceId: 'd-eg-c',
    anchorId: 'd-eg-b',
    actorName: 'Sabine Gruber',
    actorUserId: 'u-sabine',
    count: 1,
    href: '/app/projects/p1/files?doc=d-eg-c',
    subject: 'Grundriss EG Index B',
    related: 'Grundriss EG Index C',
    excerpt: 'Die Tür zum Technikraum wurde verschoben, die Wandstärke im Kern von 25 auf 30 cm erhöht.',
    mentions: [],
    // The open marks Index B leaves behind: the row says how many to check.
    variant: 'marks_earlier',
    openMarks: 4,
    marksRevision: null,
    answerIn: null,
    createdAt: ago(9),
    updatedAt: ago(9),
  },
  // A same-name Fassung: its open marks all sit on Fassung 2.
  {
    id: 'i-revision-marks',
    type: 'document.new_revision',
    state: 'read',
    archived: false,
    read: true,
    actionable: false,
    resourceType: 'document',
    resourceId: 'd-schnitt',
    anchorId: 'v-schnitt-3',
    actorName: 'Jakob Huber',
    actorUserId: 'u-jakob',
    count: 0,
    href: '/app/projects/p1/files?doc=d-schnitt',
    subject: 'Schnitt A-A',
    related: null,
    excerpt: null,
    mentions: [],
    variant: 'marks',
    openMarks: 3,
    marksRevision: 2,
    answerIn: null,
    createdAt: ago(55),
    updatedAt: ago(55),
  },
  // The content check held files back (ADR-0086): a collapsed row of three
  // naming the newest and its kind of reason, never the value found; and an
  // uploader asking for one held file's review, caught in a scan's transcript.
  {
    id: 'i-quarantined',
    type: 'document.quarantined',
    state: 'unread',
    archived: false,
    read: false,
    actionable: false,
    resourceType: 'organization',
    resourceId: 'org-1',
    anchorId: null,
    actorName: 'Sabine Gruber',
    actorUserId: 'u-sabine',
    count: 3,
    href: '/app/organization/quarantine',
    subject: 'Lohnzettel_März_2026.pdf',
    related: null,
    excerpt: null,
    mentions: [],
    variant: 'iban',
    answerIn: null,
    createdAt: ago(11),
    updatedAt: ago(11),
  },
  {
    id: 'i-release-requested',
    type: 'document.release_requested',
    state: 'unread',
    archived: false,
    read: false,
    actionable: false,
    resourceType: 'organization',
    resourceId: 'org-1',
    anchorId: 'd-scan',
    actorName: 'Lukas Berger',
    actorUserId: 'u-lukas',
    count: 1,
    href: '/app/organization/quarantine',
    subject: 'Scan_Bauakt_1987.pdf',
    related: null,
    excerpt: null,
    mentions: [],
    variant: 'transcript',
    answerIn: null,
    createdAt: ago(13),
    updatedAt: ago(13),
  },
  // What the agent did, told to the person whose act woke it (ADR-0106): which
  // mark in which document, why it did not work (the failure's `variant`),
  // and what to do now. The excerpt is what the mark says, or the agent's question.
  {
    id: 'i-agent-failed',
    type: 'piloti.work_failed',
    state: 'unread',
    archived: false,
    read: false,
    actionable: false,
    resourceType: 'document',
    resourceId: 'd-eg-c',
    anchorId: 'mark-4',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/files?doc=d-eg-c&review=1&mark=mark-4',
    subject: 'Grundriss EG',
    related: '4',
    excerpt: 'Türbreite zum Technikraum prüfen',
    mentions: [],
    variant: 'budget',
    answerIn: null,
    createdAt: ago(3),
    updatedAt: ago(3),
  },
  {
    id: 'i-agent-asks',
    type: 'piloti.asks_you',
    state: 'unread',
    archived: false,
    read: false,
    actionable: true,
    resourceType: 'document',
    resourceId: 'd-schnitt',
    anchorId: 'mark-7',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/files?doc=d-schnitt&review=1&mark=mark-7',
    subject: 'Schnitt A-A',
    related: '7',
    excerpt: 'Gilt für die Brüstung die Höhe ab Fertigfußboden oder ab Rohdecke?',
    mentions: [],
    variant: null,
    // Events do not wake the agent (the default): the answer goes in the Prüfansicht, which asks the agent.
    answerIn: 'review',
    createdAt: ago(5),
    updatedAt: ago(5),
  },
  {
    id: 'i-agent-done',
    type: 'piloti.work_done',
    state: 'read',
    archived: false,
    read: true,
    actionable: false,
    resourceType: 'document',
    resourceId: 'd-eg-c',
    anchorId: 'mark-2',
    actorName: null,
    actorUserId: null,
    count: 0,
    href: '/app/projects/p1/files?doc=d-eg-c&review=1&mark=mark-2',
    subject: 'Grundriss EG',
    related: '2',
    excerpt: 'Fluchtweglänge im Kern B nachweisen',
    mentions: [],
    variant: null,
    answerIn: null,
    createdAt: ago(40),
    updatedAt: ago(40),
  },
  // A colleague made the reader responsible for a mark: the row opens at the
  // mark, and the reader can answer or resolve it from here.
  {
    id: 'i-mark-assigned',
    type: 'annotation.assigned_to_you',
    state: 'unread',
    archived: false,
    read: false,
    actionable: true,
    resourceType: 'document',
    resourceId: 'd-eg-c',
    anchorId: 'mark-9',
    actorName: 'Anna Weber',
    actorUserId: 'u-anna',
    count: 1,
    href: '/app/projects/p1/files?doc=d-eg-c&review=1&mark=mark-9',
    subject: 'Grundriss EG',
    related: '9',
    excerpt: 'Brandschutztür T30 zum Stiegenhaus fehlt in der Legende.',
    mentions: [],
    variant: null,
    dueOn: '2026-10-24',
    answerIn: 'row',
    createdAt: ago(7),
    updatedAt: ago(7),
  },
  // The daily reminder of a Frist, in the Zuständige's row for the mark: near,
  // then passed (the same row upgraded). No actor: the calendar did it.
  {
    id: 'i-mark-due-soon',
    type: 'annotation.assigned_to_you',
    state: 'unread',
    archived: false,
    read: false,
    actionable: true,
    resourceType: 'document',
    resourceId: 'd-eg-c',
    anchorId: 'mark-11',
    actorName: null,
    actorUserId: null,
    count: 2,
    href: '/app/projects/p1/files?doc=d-eg-c&review=1&mark=mark-11',
    subject: 'Grundriss EG',
    related: '11',
    excerpt: 'Fluchtwegbreite im Gang nachweisen.',
    mentions: [],
    variant: 'due_soon',
    dueOn: '2026-10-18',
    answerIn: 'row',
    createdAt: ago(600),
    updatedAt: ago(3),
  },
  {
    id: 'i-mark-overdue',
    type: 'annotation.assigned_to_you',
    state: 'unread',
    archived: false,
    read: false,
    actionable: true,
    resourceType: 'document',
    resourceId: 'd-schnitt',
    anchorId: 'mark-2',
    actorName: null,
    actorUserId: null,
    count: 3,
    href: '/app/projects/p1/files?doc=d-schnitt&review=1&mark=mark-2',
    subject: 'Schnitt A-A',
    related: '2',
    excerpt: 'Brüstungshöhe im 2. OG unter 1,00 m.',
    mentions: [],
    variant: 'overdue',
    dueOn: '2026-10-15',
    answerIn: 'row',
    createdAt: ago(4000),
    updatedAt: ago(4),
  },
  // A colleague moved the date of a mark the reader is Zuständige for.
  {
    id: 'i-mark-redated',
    type: 'annotation.assigned_to_you',
    state: 'read',
    archived: false,
    read: true,
    actionable: true,
    resourceType: 'document',
    resourceId: 'd-eg-c',
    anchorId: 'mark-12',
    actorName: 'Anna Weber',
    actorUserId: 'u-anna',
    count: 0,
    href: '/app/projects/p1/files?doc=d-eg-c&review=1&mark=mark-12',
    subject: 'Grundriss EG',
    related: '12',
    excerpt: 'Schachtquerschnitt mit der Haustechnik abstimmen.',
    mentions: [],
    variant: 'due',
    dueOn: '2026-10-31',
    answerIn: 'row',
    createdAt: ago(300),
    updatedAt: ago(40),
  },
  // A colleague @mentioned the reader in a mark's thread, with the chat's
  // picker: the row opens at the mark, and the reader can answer from here.
  {
    id: 'i-mark-mentioned',
    type: 'annotation.mentioned',
    state: 'unread',
    archived: false,
    read: false,
    actionable: true,
    resourceType: 'document',
    resourceId: 'd-eg-c',
    anchorId: 'mark-11',
    actorName: 'Jakob Huber',
    actorUserId: 'u-jakob',
    count: 1,
    href: '/app/projects/p1/files?doc=d-eg-c&review=1&mark=mark-11',
    subject: 'Grundriss EG',
    related: '11',
    excerpt: '@Miriam Hofer passt die Brüstungshöhe im Zimmer 1 zur Einreichung?',
    // Drawn as the thread's chip, louder: Miriam is the reader here.
    mentions: [{ targetId: VIEWER_ID, display: 'Miriam Hofer' }],
    variant: null,
    answerIn: 'row',
    // Events wake the agent in this office: „Antworten" opens the thread's composer with @{productName} beside Send.
    pilotiWakes: true,
    createdAt: ago(3),
    updatedAt: ago(3),
  },
  // Two replies on a mark the reader wrote, the newest by Markus.
  {
    id: 'i-mark-activity',
    type: 'annotation.activity',
    state: 'unread',
    archived: false,
    read: false,
    actionable: false,
    resourceType: 'document',
    resourceId: 'd-schnitt',
    anchorId: 'mark-3',
    actorName: 'Markus Hofer',
    actorUserId: 'u-markus',
    count: 2,
    href: '/app/projects/p1/files?doc=d-schnitt&review=1&mark=mark-3',
    subject: 'Schnitt A-A',
    related: '3',
    excerpt: 'Passt, die Brüstung ist mit 1,00 m ab FFB eingetragen.',
    mentions: [],
    variant: 'reply',
    answerIn: null,
    createdAt: ago(30),
    updatedAt: ago(14),
  },
  // A colleague's review of a document the reader is Verantwortlich for: fifteen new marks, one counted row.
  {
    id: 'i-marks-set',
    type: 'annotation.activity',
    state: 'unread',
    archived: false,
    read: false,
    actionable: false,
    resourceType: 'document',
    resourceId: 'd-grundriss',
    anchorId: 'mark-15',
    actorName: 'Anna Weber',
    actorUserId: 'u-anna',
    count: 15,
    href: '/app/projects/p1/files?doc=d-grundriss&review=1&mark=mark-15',
    subject: 'Grundriss EG',
    related: '15',
    excerpt: 'Fluchtwegbreite im Stiegenhaus mit 1,20 m kotieren.',
    mentions: [],
    variant: 'created',
    answerIn: null,
    createdAt: ago(48),
    updatedAt: ago(9),
  },
  // The agent's proposals a colleague took over, on a document the reader uploaded:
  // a proposal tells nobody until then, and then reads as the agent's marks for them.
  {
    id: 'i-marks-taken-over',
    type: 'annotation.activity',
    state: 'read',
    archived: false,
    read: true,
    actionable: false,
    resourceType: 'document',
    resourceId: 'd-schnitt',
    anchorId: 'mark-8',
    actorName: 'Markus Hofer',
    actorUserId: 'u-markus',
    count: 3,
    href: '/app/projects/p1/files?doc=d-schnitt&review=1&mark=mark-8',
    subject: 'Schnitt A-A',
    related: '8',
    excerpt: 'Brüstungshöhe im Schnitt nicht kotiert (OIB-RL 4, Pkt. 4.2).',
    mentions: [],
    variant: 'created_piloti',
    answerIn: null,
    createdAt: ago(200),
    updatedAt: ago(180),
  },
  {
    id: 'i-agent-proposal',
    type: 'piloti.proposal_waiting',
    state: 'unread',
    archived: false,
    read: false,
    actionable: true,
    // A filing suggestion no chat made: it waits on its file under Dateien.
    resourceType: 'project',
    resourceId: 'p1',
    anchorId: 'prop-1',
    actorName: null,
    actorUserId: null,
    count: 1,
    href: '/app/projects/p1/files',
    subject: null,
    related: null,
    excerpt: 'Grundriss EG.pdf, Schnitt A-A.pdf +3',
    mentions: [],
    variant: 'move',
    answerIn: null,
    createdAt: ago(12),
    updatedAt: ago(12),
  },
  {
    // A request a colleague answered before the reader opened it: resolved and
    // still unread. The badge counts it, so the queue must show it as news.
    id: 'i-answered-unread',
    type: 'mention.requested',
    state: 'resolved',
    archived: false,
    read: false,
    actionable: true,
    resourceType: 'conversation',
    resourceId: 'c9',
    anchorId: 'm-9',
    actorName: 'Jakob Huber',
    actorUserId: 'u-jakob',
    count: 1,
    href: '/app/projects/p1/chat?session=c9#m-9',
    subject: 'Stellplätze Tiefgarage',
    related: null,
    excerpt: 'Sind 42 Stellplätze für die Einreichung genug?',
    mentions: [],
    variant: null,
    answerIn: null,
    createdAt: ago(95),
    updatedAt: ago(95),
  },
]

/** Newest first, as the server orders a page. */
const NEWEST_FIRST = [...withProjects(ITEMS)].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))

const isOpenRequest = (item: InboxItemView) => item.actionable && item.state !== 'resolved' && item.state !== 'inert'

/** The badge's set: outstanding requests + unread. */
const PENDING = NEWEST_FIRST.filter((item) => isOpenRequest(item) || (!item.read && item.state !== 'inert'))

/** What each `?filter=` returns (`InboxListFilter`). Nothing is archived in this fixture. */
const BY_FILTER: Record<string, InboxItemView[]> = {
  pending: PENDING,
  requests: NEWEST_FIRST.filter(isOpenRequest),
  unread: NEWEST_FIRST.filter((item) => !item.read && item.state !== 'inert'),
  all: NEWEST_FIRST,
  archived: [],
}

/** A page size small enough that „Ältere Einträge laden“ shows in the evidence. */
const PAGE = 12

/**
 * `?variant=empty` serves an inbox with nothing in it, so the crafted empty state
 * is captured as its own piece of evidence (NF-10 lists "empty inbox" separately).
 * Read at request time rather than at install time so a client-side navigation
 * between the two variants still serves the right fixture.
 */
export const isEmptyVariant = (): boolean =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('variant') === 'empty'

/**
 * Serves the fixture inbox to `fetch`, once per page, in development only: the
 * previews render the real list, queue and dock with no backend. Installed at
 * MODULE SCOPE by each preview, because a child's effects run before its
 * parent's and the list's first read would otherwise race the shim.
 */
export function installInboxShim(): void {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'development') return
  const w = window as unknown as { __inboxShim?: boolean }
  if (!w.__inboxShim) {
    w.__inboxShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const empty = isEmptyVariant()
      if (url.startsWith('/api/inbox/summary')) {
        return Response.json({ pending: empty ? 0 : PENDING.length })
      }
      if (url.startsWith('/api/inbox') && (init?.method ?? 'GET') !== 'GET') {
        // Every mutation lands; the list re-reads the same fixture.
        return Response.json({ affected: 1, pending: empty ? 0 : PENDING.length })
      }
      if (url.startsWith('/api/inbox')) {
        const counts = {
          requests: empty ? 0 : BY_FILTER.requests.length,
          unread: empty ? 0 : PENDING.filter((item) => !item.read && item.state !== 'inert').length,
        }
        if (empty) return Response.json({ items: [], pending: 0, counts, hasMore: false, nextCursor: null })
        const params = new URL(url, window.location.origin).searchParams
        const rows = BY_FILTER[params.get('filter') ?? 'all'] ?? NEWEST_FIRST
        const start = Number(params.get('cursor') ?? 0)
        const items = rows.slice(start, start + PAGE)
        const hasMore = start + PAGE < rows.length
        return Response.json({ items, pending: PENDING.length, counts, hasMore, nextCursor: hasMore ? String(start + PAGE) : null })
      }
      // „Antworten" from a mark's row: the thread's composer asks who may open
      // the document for its „@" picker, and sends through the reply route.
      if (/^\/api\/assignments\/document\/[^/]+\/candidates/.test(url)) {
        return Response.json({ candidates: MENTIONABLE })
      }
      // „Antworten" on a mark's row sends through the reply route.
      const reply = /^\/api\/documents\/([^/]+)\/annotations\/([^/?]+)\/replies$/.exec(url)
      if (reply && init?.method === 'POST') {
        return Response.json(replyToMark(reply[1], reply[2], JSON.parse(String(init.body ?? '{}'))), { status: 201 })
      }
      // The live channel is deliberately absent here: the list must render fully
      // from the plain fetch (spec RT-3/RT-4), which is what a screenshot proves.
      if (url.startsWith('/api/stream')) {
        return new Response(null, { status: 404 })
      }
      return real(input, init)
    }
  }
}
