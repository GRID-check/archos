'use client'

/**
 * Dev preview for the project lifecycle (ADR-0098): the REAL status card and
 * banner in each state, side by side.
 *
 *   - Aktiv: pause, or close (the three-step close dialog opens on „Projekt
 *     abschließen"; its debrief step has its own preview, `/dev/closing-debrief`).
 *   - Ruhend: since when, resume, or close; the banner offers „Fortsetzen".
 *   - Abgeschlossen, nicht realisiert: how and when it ended, reopen; the banner
 *     says so and offers „Wieder öffnen".
 *
 * A module-scope fetch shim answers the status move with a 409, so the preview
 * never changes, and the clear-out proposal with nothing to remove. Pinned to
 * German, the product's primary language (`docs/ux/visual-screenshots.md`).
 */

import type { JSX } from 'react'
import { I18nProvider } from '@/i18n'
import { ProjectLifecycleCard } from '@/features/projects/components/project-lifecycle-card'
import { ProjectStatusBanner } from '@/features/projects/components/project-status-banner'
import { CurrentProjectProvider } from '@/features/projects/lib/current-project'
import type { ProjectLifecycleView } from '@/lib/projects/project-status'

const ACTIVE: ProjectLifecycleView = {
  status: 'active',
  pausedAt: null,
  closedAt: null,
  closedOutcome: null,
  endedOn: null,
  startedOn: '2023-04',
  suggestedEndedOn: null,
  suggestedOutcome: null,
}
const PAUSED: ProjectLifecycleView = { ...ACTIVE, status: 'paused', pausedAt: '2026-08-14T09:00:00Z' }
const CLOSED: ProjectLifecycleView = {
  ...ACTIVE,
  status: 'closed',
  closedAt: '2026-10-06T16:00:00Z',
  closedOutcome: 'cancelled',
  endedOn: '2026-09',
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith('/cleanup/proposal')) return Response.json({ items: [], considered: 0, aiUsed: false, aiError: null })
    if (url.endsWith('/memory')) return Response.json({ items: [] })
    if (url.endsWith('/status')) return new Response('{}', { status: 409 })
    return real(input, init)
  }
}

function State({ id, lifecycle }: { id: string; lifecycle: ProjectLifecycleView }): JSX.Element {
  return (
    <section className="space-y-3" data-testid={`lifecycle-${lifecycle.status}`}>
      <CurrentProjectProvider
        value={{
          id,
          name: 'Wohnbau Mariahilf',
          status: lifecycle.status,
          closedAt: lifecycle.closedAt,
          readsBecauseClosed: false,
          lifecycle,
          canChangeStatus: true,
        }}
      >
        <ProjectStatusBanner />
      </CurrentProjectProvider>
      <ProjectLifecycleCard projectId={id} lifecycle={lifecycle} />
    </section>
  )
}

export default function ProjectLifecycleDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="bg-background mx-auto max-w-3xl space-y-10 p-4 sm:p-8" data-testid="project-lifecycle-preview">
        <State id="dev-lifecycle-active" lifecycle={ACTIVE} />
        <State id="dev-lifecycle-paused" lifecycle={PAUSED} />
        <State id="dev-lifecycle-closed" lifecycle={CLOSED} />
      </main>
    </I18nProvider>
  )
}
