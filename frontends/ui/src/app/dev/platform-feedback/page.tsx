'use client'

/**
 * Dev preview for Platform → Feedback — the real `FeedbackTriage` with an
 * in-memory client, so the list, the filters, a deep-linked report and a
 * status change can be reviewed and screenshotted without a backend. 404s
 * outside development.
 *
 *   /dev/platform-feedback               an owner who may triage
 *   /dev/platform-feedback?focus=f2      as reached from an inbox row
 *   /dev/platform-feedback?readonly=1    Platform Support: view only
 *   /dev/platform-feedback?empty=1       nothing new
 *   /dev/platform-feedback?source=local  PostHog not configured or unreachable: the local log
 *
 * The PostHog list always carries one report whose ticket failed to open
 * (`unticketed`), so the "not in PostHog yet" section is in every capture.
 */

import type { JSX } from 'react'
import * as React from 'react'
import { useSearchParams } from 'next/navigation'

import { PageHeader } from '@/components/ui/page-header'
import { I18nProvider, useTranslations } from '@/i18n'
import {
  FeedbackTriage,
  type FeedbackTriageClient,
} from '@/features/product-feedback/components/feedback-triage'
import {
  SUPPORT_TICKET_STATUSES,
  type ProductFeedbackListResponse,
  type ProductFeedbackReportView,
  type SupportTicketStatus,
} from '@/lib/product-feedback/types'

const now = Date.now()
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()

const CONTEXT = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
  viewport: '1512×864',
  locale: 'de-AT',
  timeZone: 'Europe/Vienna',
}

const POSTHOG = 'https://eu.posthog.com/project/12345'

const ticket = (id: string, number: number, status: SupportTicketStatus) => ({
  id,
  number,
  status,
  url: `${POSTHOG}/support/tickets/${id}`,
})

const person = (userId: string): string => `${POSTHOG}/person/${userId}`

const SEED: ProductFeedbackReportView[] = [
  {
    id: 'f1',
    kind: 'bug',
    ticket: ticket('5b1f0c2e-1d4a-4c7e-9f3b-2a6d8e0c4b11', 41, 'new'),
    posthogPersonUrl: person('u1'),
    message:
      'Beim Hochladen eines 80-MB-Plans bleibt der Fortschritt bei 99 % stehen, auch nach 10 Minuten. Nach einem Neuladen ist die Datei nicht im Projekt.',
    pagePath: '/app/projects/3f2a/files',
    context: CONTEXT,
    allowContact: true,
    organizationId: 'org_nord',
    organizationName: 'Architekturbüro Nord',
    reporter: { userId: 'u1', name: 'Maria Huber', email: 'maria.huber@buero-nord.at' },
    createdAt: ago(4),
    updatedAt: ago(4),
  },
  {
    id: 'f2',
    kind: 'idea',
    ticket: ticket('7c2e1d3f-2e5b-4d8f-8a4c-3b7e9f1d5c22', 40, 'new'),
    posthogPersonUrl: person('u2'),
    message:
      'Es wäre großartig, wenn ich eine Antwort direkt als Aktennotiz ins Archiv legen könnte, mit Quellenangaben.\n\nDerzeit kopiere ich alles händisch in Word.',
    pagePath: '/app/projects/3f2a/chat',
    context: CONTEXT,
    allowContact: true,
    organizationId: 'org_sued',
    organizationName: 'Ingenieurbüro Süd',
    reporter: { userId: 'u2', name: 'Thomas Leitner', email: 'leitner@ib-sued.at' },
    createdAt: ago(95),
    updatedAt: ago(95),
  },
  {
    id: 'f3',
    kind: 'praise',
    ticket: ticket('9d3f2e4a-3f6c-4e9a-9b5d-4c8f0a2e6d33', 39, 'pending'),
    posthogPersonUrl: person('u3'),
    message:
      'Die Herleitung der OIB-2-Anforderungen hat uns heute einen halben Tag gespart. Danke!',
    pagePath: '/app/projects/9c1d/chat',
    context: {},
    allowContact: false,
    organizationId: 'org_nord',
    organizationName: 'Architekturbüro Nord',
    reporter: { userId: 'u3', name: 'Sabine Gruber', email: null },
    createdAt: ago(60 * 26),
    updatedAt: ago(60 * 26),
  },
  {
    id: 'f4',
    kind: 'question',
    ticket: ticket('1e4a3f5b-4a7d-4fab-8c6e-5d9a1b3f7e44', 37, 'open'),
    posthogPersonUrl: person('u4'),
    message:
      'Kann ich eigene Normen (z. B. ÖNORM B 1600) hochladen, damit Piloti sie berücksichtigt?',
    pagePath: '/app/office-shelf',
    context: CONTEXT,
    allowContact: true,
    organizationId: 'org_west',
    organizationName: 'Planungsgruppe West',
    reporter: { userId: 'u4', name: 'Lukas Berger', email: 'lb@pg-west.at' },
    createdAt: ago(60 * 48),
    updatedAt: ago(60 * 20),
  },
]

/** A report whose ticket failed to open: shown apart while PostHog is read. */
const UNTICKETED: ProductFeedbackReportView = {
  id: 'f5',
  kind: 'bug',
  ticket: null,
  posthogPersonUrl: person('u5'),
  message: 'Der Export als PDF bricht ohne Meldung ab, sobald das Dokument mehr als 40 Seiten hat.',
  pagePath: '/app/projects/3f2a/export',
  context: CONTEXT,
  allowContact: true,
  organizationId: 'org_west',
  organizationName: 'Planungsgruppe West',
  reporter: { userId: 'u5', name: 'Eva Steiner', email: 'steiner@pg-west.at' },
  createdAt: ago(12),
  updatedAt: ago(12),
}

const byNewest = (a: ProductFeedbackReportView, b: ProductFeedbackReportView): number =>
  b.createdAt.localeCompare(a.createdAt)

/**
 * An in-memory stand-in for the BFF. `posthog` lists the tickets and keeps the
 * unticketed report apart; `local` is the fallback, every report newest first
 * with no ticket and no counts.
 */
function memoryClient(empty: boolean, source: ProductFeedbackListResponse['source']): FeedbackTriageClient {
  let reports = empty ? [] : SEED.map((report) => ({ ...report }))
  const unticketed = empty ? [] : [UNTICKETED]
  const counts = () =>
    reports.reduce<Record<SupportTicketStatus, number>>(
      (acc, report) => (report.ticket ? { ...acc, [report.ticket.status]: acc[report.ticket.status] + 1 } : acc),
      Object.fromEntries(SUPPORT_TICKET_STATUSES.map((status) => [status, 0])) as Record<SupportTicketStatus, number>
    )
  const local = (report: ProductFeedbackReportView): ProductFeedbackReportView => ({ ...report, ticket: null })
  return {
    list: async ({ status, kind }) =>
      source === 'local'
        ? {
            source,
            reports: [...reports, ...unticketed]
              .map(local)
              .filter((report) => !kind || report.kind === kind)
              .sort(byNewest),
            counts: null,
            unticketed: [],
            nextCursor: null,
          }
        : {
            source,
            reports: reports.filter(
              (report) => (!status || report.ticket?.status === status) && (!kind || report.kind === kind)
            ),
            counts: counts(),
            unticketed: unticketed.filter((report) => !kind || report.kind === kind),
            nextCursor: null,
          },
    get: async (id) => {
      const found = [...reports, ...unticketed].find((report) => report.id === id) ?? null
      return found && source === 'local' ? local(found) : found
    },
    triage: async (id, status) => {
      reports = reports.map((report) =>
        report.id === id && report.ticket
          ? { ...report, ticket: { ...report.ticket, status }, updatedAt: new Date().toISOString() }
          : report
      )
      const updated = reports.find((report) => report.id === id)
      if (!updated) throw new Error('unknown')
      return updated
    },
  }
}

/** The real page's header, so the capture shows the card in its context. */
function PreviewHeader(): JSX.Element {
  const t = useTranslations('platform')
  return (
    <PageHeader title={t('sections.feedback.title')} subtitle={t('sections.feedback.subtitle')} />
  )
}

function Preview(): JSX.Element {
  const params = useSearchParams()
  const empty = params.get('empty') === '1'
  const source = params.get('source') === 'local' ? 'local' : 'posthog'
  const client = React.useMemo(() => memoryClient(empty, source), [empty, source])
  return (
    <I18nProvider initialLocale={params.get('lang') === 'en' ? 'en' : 'de'} fixedLocale>
      <div className="bg-background min-h-dvh px-4 py-8 md:px-8">
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
          <PreviewHeader />
          <FeedbackTriage
            canTriage={params.get('readonly') !== '1'}
            focusReportId={params.get('focus')}
            client={client}
          />
        </div>
      </div>
    </I18nProvider>
  )
}

export default function PlatformFeedbackDevPage(): JSX.Element {
  return (
    <React.Suspense>
      <Preview />
    </React.Suspense>
  )
}
