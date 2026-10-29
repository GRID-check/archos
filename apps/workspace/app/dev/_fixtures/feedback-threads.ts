/**
 * A fake „Mein Feedback" backend for the dev previews: one member's cases
 * (active and done), their office's, a conversation with the team, and the
 * degraded states. `/dev/feedback-threads`, `/dev/feedback` and `/dev/phone-more`
 * share it, so the modal looks the same from every door. A report sent from its
 * form joins the fake list, so the hand-off to the new thread can be reviewed.
 */

import type { FeedbackThreadsApi } from '@/features/product-feedback/components'
import type {
  OwnProductFeedbackListResponse,
  OwnProductFeedbackMessage,
  OwnProductFeedbackSummary,
  OwnProductFeedbackThread,
} from '@/lib/product-feedback/types'
import type { SubmitProductFeedbackRequest, SubmitProductFeedbackResult } from '@/lib/product-feedback/client'
import { PRODUCT_NAME } from '@/lib/brand'

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

/** Which state the fake answers in. */
export type FeedbackPreviewView =
  | 'list'
  | 'thread'
  | 'waiting'
  | 'readonly'
  | 'offline'
  | 'empty'
  | 'office'
  | 'colleague'
  | 'long'
  | 'compose'

const mine = (summary: Omit<OwnProductFeedbackSummary, 'mine' | 'reporterName'>): OwnProductFeedbackSummary => ({
  ...summary,
  mine: true,
  reporterName: 'Maria Huber',
})

export const FEEDBACK_PREVIEW_REPORTS: OwnProductFeedbackSummary[] = [
  mine({
    id: '0b1c2d3e-4f50-4617-8899-aabbccddee01',
    kind: 'bug',
    excerpt:
      'Beim Hochladen eines 80-MB-Plans bleibt der Fortschritt bei 99 % stehen. Nach einem Neuladen ist die Datei nicht im Projekt.',
    createdAt: minutesAgo(180),
    status: 'pending',
    ticketNumber: 41,
    lastActivityAt: minutesAgo(42),
    hasUpdate: true,
    canReply: true,
  }),
  mine({
    id: '0b1c2d3e-4f50-4617-8899-aabbccddee02',
    kind: 'idea',
    excerpt: 'Eine Exportfunktion für den Prüfbericht als Word-Datei wäre für die Einreichung sehr hilfreich.',
    createdAt: minutesAgo(60 * 26),
    status: 'new',
    ticketNumber: 38,
    lastActivityAt: minutesAgo(60 * 26),
    hasUpdate: false,
    canReply: true,
  }),
  mine({
    id: '0b1c2d3e-4f50-4617-8899-aabbccddee04',
    kind: 'question',
    excerpt: 'Wie übernehme ich die Stellplatzverordnung aus dem Vorprojekt in ein neues Projekt?',
    createdAt: minutesAgo(60 * 24 * 4),
    status: 'open',
    ticketNumber: 33,
    lastActivityAt: minutesAgo(60 * 24 * 2),
    hasUpdate: false,
    canReply: true,
  }),
  mine({
    id: '0b1c2d3e-4f50-4617-8899-aabbccddee03',
    kind: 'praise',
    excerpt: 'Die Zitate mit Fundstelle im OIB-Leitfaden sparen mir jeden Tag Zeit. Danke!',
    createdAt: minutesAgo(60 * 24 * 9),
    status: 'resolved',
    ticketNumber: 21,
    lastActivityAt: minutesAgo(60 * 24 * 8),
    hasUpdate: false,
    canReply: false,
  }),
]

const COLLEAGUES: OwnProductFeedbackSummary[] = [
  {
    id: '0b1c2d3e-4f50-4617-8899-aabbccddee11',
    kind: 'bug',
    excerpt: 'Die Plankopf-Erkennung liest bei unseren Einreichplänen den Maßstab 1:100 als 1:1000.',
    createdAt: minutesAgo(60 * 5),
    status: 'open',
    ticketNumber: 43,
    lastActivityAt: minutesAgo(25),
    hasUpdate: false,
    canReply: false,
    mine: false,
    reporterName: 'Jakob Steiner',
  },
  {
    id: '0b1c2d3e-4f50-4617-8899-aabbccddee12',
    kind: 'question',
    excerpt: 'Kann ich einem Projektpartner ohne ' + PRODUCT_NAME + '-Konto einzelne Fassungen zum Lesen freigeben?',
    createdAt: minutesAgo(60 * 30),
    status: 'pending',
    ticketNumber: 39,
    lastActivityAt: minutesAgo(60 * 20),
    hasUpdate: false,
    canReply: false,
    mine: false,
    reporterName: 'Lena Gruber',
  },
  {
    id: '0b1c2d3e-4f50-4617-8899-aabbccddee13',
    kind: 'bug',
    excerpt: 'Der Export der Mängelliste bricht bei mehr als 200 Punkten ab.',
    createdAt: minutesAgo(60 * 24 * 12),
    status: 'resolved',
    ticketNumber: 17,
    lastActivityAt: minutesAgo(60 * 24 * 10),
    hasUpdate: false,
    canReply: false,
    mine: false,
    reporterName: 'Jakob Steiner',
  },
]

const CONVERSATION: OwnProductFeedbackMessage[] = [
  {
    id: 'm1',
    author: 'reporter',
    authorName: null,
    content: FEEDBACK_PREVIEW_REPORTS[0]!.excerpt,
    createdAt: minutesAgo(180),
  },
  {
    id: 'm2',
    author: 'team',
    authorName: 'Matthias',
    content:
      'Danke für die genaue Beschreibung! Wir sehen den Abbruch in den Logs. Passiert das auch mit kleineren Dateien, oder nur ab einer bestimmten Größe?',
    createdAt: minutesAgo(42),
  },
]

/** A long back-and-forth, for the scroll and the newest-in-view checks. */
const LONG: OwnProductFeedbackMessage[] = [
  ...CONVERSATION,
  ...Array.from({ length: 6 }, (_, index): OwnProductFeedbackMessage => ({
    id: `l${index}`,
    author: index % 2 === 0 ? 'reporter' : 'team',
    authorName: index % 2 === 0 ? null : 'Matthias',
    content:
      index % 2 === 0
        ? `Nachtrag ${index / 2 + 1}: Es passiert auch in Safari, und nur mit Plänen über 50 MB. Der Upload-Dialog zeigt dabei keine Fehlermeldung.`
        : 'Danke, das hilft. Wir haben die Grenze im Upload gefunden und testen gerade einen Fix.',
    createdAt: minutesAgo(40 - index * 5),
  })),
]

function listOf(reports: OwnProductFeedbackSummary[], canViewOffice: boolean): OwnProductFeedbackListResponse {
  return {
    reports,
    updatedCount: reports.filter((report) => report.hasUpdate && report.mine).length,
    live: true,
    nextCursor: null,
    canViewOffice,
  }
}

function threadFor(id: string, view: FeedbackPreviewView, extra: OwnProductFeedbackMessage[]): OwnProductFeedbackThread {
  const colleague = COLLEAGUES.find((candidate) => candidate.id === id)
  if (colleague) {
    const first: OwnProductFeedbackMessage = { id: 'c1', author: 'reporter', authorName: null, content: colleague.excerpt, createdAt: colleague.createdAt }
    const answer: OwnProductFeedbackMessage = {
      id: 'c2',
      author: 'team',
      authorName: 'Matthias',
      content: 'Danke, Jakob! Wir können das mit Ihrem Plan nachstellen und sehen uns die Erkennung an.',
      createdAt: colleague.lastActivityAt,
    }
    return { report: colleague, messages: [first, answer], live: true }
  }
  const report = FEEDBACK_PREVIEW_REPORTS.find((candidate) => candidate.id === id) ?? FEEDBACK_PREVIEW_REPORTS[0]!
  if (view === 'offline') {
    return { report: { ...report, status: null, ticketNumber: null, hasUpdate: false }, messages: CONVERSATION.slice(0, 1), live: false }
  }
  if (view === 'waiting' || report.id !== FEEDBACK_PREVIEW_REPORTS[0]!.id) {
    const first = { ...CONVERSATION[0]!, content: report.excerpt, createdAt: report.createdAt }
    return { report: { ...report, hasUpdate: false }, messages: [first, ...extra], live: true }
  }
  if (view === 'readonly') {
    return { report: { ...report, canReply: false, hasUpdate: false }, messages: CONVERSATION, live: true }
  }
  // Once the reporter has answered, the ticket is the team's move again.
  const status = extra.length > 0 ? 'open' : report.status
  const messages = view === 'long' ? LONG : CONVERSATION
  return { report: { ...report, status, hasUpdate: false }, messages: [...messages, ...extra], live: true }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A report the preview's form filed: a fresh case nobody has answered. */
function filed(request: SubmitProductFeedbackRequest, index: number): OwnProductFeedbackSummary {
  const now = new Date().toISOString()
  return mine({
    id: `0b1c2d3e-4f50-4617-8899-${String(index).padStart(12, '0')}`,
    kind: request.kind,
    excerpt: request.message,
    createdAt: now,
    status: 'new',
    ticketNumber: 44 + index,
    lastActivityAt: now,
    hasUpdate: false,
    canReply: true,
  })
}

/**
 * The fake API for one view. Sending a reply appends it to the fake thread;
 * sending the form files a new case at the top of the list (or fails, with
 * `failSubmit`). Build it once per view (`useMemo`): the provider re-reads its
 * count whenever the `list` function changes.
 */
export function feedbackPreviewApi(
  view: FeedbackPreviewView,
  { failSubmit = false }: { failSubmit?: boolean } = {},
): FeedbackThreadsApi {
  let extra: OwnProductFeedbackMessage[] = []
  let sent: OwnProductFeedbackSummary[] = []
  const office = view === 'office' || view === 'colleague' || view === 'compose'
  return {
    list: async () => {
      await wait(250)
      return listOf([...sent, ...(view === 'empty' ? [] : FEEDBACK_PREVIEW_REPORTS)], office || view === 'list')
    },
    office: async () => {
      await wait(250)
      return listOf([...COLLEAGUES, ...sent, ...FEEDBACK_PREVIEW_REPORTS], true)
    },
    thread: async (id) => {
      await wait(250)
      const own = sent.find((report) => report.id === id)
      if (own) {
        const first: OwnProductFeedbackMessage = { id: `${id}-1`, author: 'reporter', authorName: null, content: own.excerpt, createdAt: own.createdAt }
        return { report: own, messages: [first], live: true }
      }
      return threadFor(id, view, extra)
    },
    submit: async (request): Promise<SubmitProductFeedbackResult> => {
      await wait(400)
      if (failSubmit) return { ok: false, reason: 'failed' }
      const report = filed(request, sent.length + 1)
      sent = [report, ...sent]
      return { ok: true, report: { id: report.id, kind: report.kind, createdAt: report.createdAt } }
    },
    reply: async (id, message) => {
      await wait(400)
      extra = [
        ...extra,
        { id: `r${extra.length}`, author: 'reporter', authorName: null, content: message, createdAt: new Date().toISOString() },
      ]
      return { ok: true, thread: threadFor(id, view, extra) }
    },
  }
}

/** The thread a view opens on, or `null` for the list. */
export function feedbackPreviewStart(view: FeedbackPreviewView): string | null {
  if (view === 'thread' || view === 'readonly' || view === 'offline' || view === 'long') return FEEDBACK_PREVIEW_REPORTS[0]!.id
  if (view === 'waiting') return FEEDBACK_PREVIEW_REPORTS[1]!.id
  if (view === 'colleague') return COLLEAGUES[0]!.id
  return null
}

export function parseFeedbackPreviewView(value: string | null): FeedbackPreviewView {
  const views: FeedbackPreviewView[] = ['list', 'thread', 'waiting', 'readonly', 'offline', 'empty', 'office', 'colleague', 'long', 'compose']
  return views.includes(value as FeedbackPreviewView) ? (value as FeedbackPreviewView) : 'list'
}
