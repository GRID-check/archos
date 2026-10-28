'use client'

/**
 * Dev preview for a task's run history — the surface that has to answer, per
 * run, "what became of this one, and where did it end up?". Renders the REAL
 * JobRunHistory with a fetch shim for its one read,
 * `GET /api/projects/…/runs?taskId=…`, whose rows carry the run's own status.
 *
 * The fixture is one row per outcome, so every badge and link is on the same
 * screen: a run still going, two that finished, one that failed (the row that
 * used to read „Übermittelt"), and one that never reached the agent (skipped,
 * no thread — so no link).
 * Not linked from anywhere and 404s outside development (see ../layout.tsx).
 */

import type { JSX } from 'react'
import { I18nProvider } from '@/i18n'
import { JobRunHistory } from '@/features/jobs/components/job-run-history'
import type { TaskRunView } from '@/lib/tasks/task-wire'

const NOW = Date.now()
const at = (offsetHours: number): string => new Date(NOW + offsetHours * 3600_000).toISOString()

const run = (overrides: Partial<TaskRunView> & Pick<TaskRunView, 'id' | 'status' | 'createdAt'>): TaskRunView => ({
  taskId: 'j1',
  kind: 'deep-research',
  title: 'Wöchentlicher OIB-Brandschutz-Scan',
  goal: null,
  review: null,
  reviewReason: null,
  filedDocumentId: null,
  conversationId: 'conv-8f21',
  runMessageId: null,
  trigger: 'schedule',
  requesterUserId: 'user_1',
  requesterName: 'Anna Berger',
  finishedAt: null,
  error: null,
  ...overrides,
})

const RUNS: TaskRunView[] = [
  run({ id: 'r1', trigger: 'manual', status: 'running', createdAt: at(-0.3), runMessageId: 'msg-r1' }),
  run({ id: 'r2', status: 'succeeded', createdAt: at(-24 * 7), runMessageId: 'msg-r2' }),
  run({ id: 'r3', status: 'succeeded', createdAt: at(-24 * 14) }),
  run({
    id: 'r4',
    status: 'failed',
    createdAt: at(-24 * 21),
    error: 'Die Recherche wurde nach 30 Minuten ohne Ergebnis beendet.',
  }),
  run({
    id: 'r5',
    status: 'skipped',
    createdAt: at(-24 * 28),
    conversationId: null,
    error: 'Die Organisation hatte bereits die maximale Anzahl aktiver Läufe.',
  }),
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __jobRunHistoryShim?: boolean }
  if (!w.__jobRunHistoryShim) {
    w.__jobRunHistoryShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/runs')) {
        return Response.json({ runs: RUNS, nextCursor: null })
      }
      return real(input, init)
    }
  }
}

export default function JobRunHistoryDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="job-run-history-preview"
        // The history renders inside a task card's collapsible, so it is shown
        // here at that width and on that surface rather than full-bleed. The
        // page carries `bg-background text-foreground` and the card carries
        // `text-card-foreground` because the real project layout and the real
        // Card do — without them the rows inherit the UA default black and the
        // preview invents a dark-mode contrast bug the product does not have.
        className="min-h-dvh bg-background p-8 text-foreground"
      >
        <div className="mx-auto w-full max-w-[720px] rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-5">
          <h2 className="mb-1 text-sm font-semibold text-foreground">Ausführungsverlauf</h2>
          <div className="border-t border-border pt-1">
            <JobRunHistory projectId="p1" jobId="j1" />
          </div>
        </div>
      </main>
    </I18nProvider>
  )
}
