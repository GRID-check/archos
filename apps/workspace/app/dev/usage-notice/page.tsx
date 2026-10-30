'use client'

/**
 * Dev preview for the chat's usage notice (`features/chat/components/UsageNotice.tsx`).
 * Renders the REAL notice at each level, as the viewer it most often meets:
 *
 *  - a forecast of the office's month, for a member (percent only);
 *  - a warning on a member's own daily limit (amounts, since it is theirs);
 *  - a project nearly spent, for its admin (amounts and the limit button);
 *  - the office's day spent, for a member (an alert, not dismissible);
 *  - the same, for a budget admin on its own key (tokens).
 *
 * Each sits over a stand-in composer so the spacing reads as in the chat. Not
 * linked from anywhere; the `/dev` layout 404s it outside development.
 */

import { useState, type JSX } from 'react'
import { UsageNotice } from '@/features/chat/components/UsageNotice'
import type { ChatUsageNotice } from '@/lib/budgets/usage-notice'
import { PRODUCT_NAME } from '@/lib/brand'

const base: ChatUsageNotice = {
  level: 'warning',
  scope: 'organization',
  window: 'day',
  unit: 'credit',
  percent: 82,
  amounts: null,
  resetsAt: '2026-10-22T00:00:00.000Z',
  runsOutAt: null,
  canChange: false,
  href: '/app/organization/budgets',
  key: 'preview',
}

const SAMPLES: Array<{ title: string; notice: ChatUsageNotice }> = [
  {
    title: 'Forecast: the office’s month, member',
    notice: {
      ...base,
      level: 'forecast',
      window: 'month',
      percent: 72,
      resetsAt: '2026-11-01T00:00:00.000Z',
      runsOutAt: '2026-10-28T09:00:00.000Z',
    },
  },
  {
    title: 'Warning: own daily limit, member',
    notice: { ...base, scope: 'member', amounts: { used: 41, limit: 50 } },
  },
  {
    title: 'Critical: project month, project admin',
    notice: {
      ...base,
      level: 'critical',
      scope: 'project',
      window: 'month',
      percent: 96,
      amounts: { used: 1920, limit: 2000 },
      resetsAt: '2026-11-01T00:00:00.000Z',
      canChange: true,
      href: '/app/projects/demo/settings/usage',
    },
  },
  {
    title: 'Exhausted: the office’s day, member',
    notice: { ...base, level: 'exhausted', percent: 100 },
  },
  {
    title: 'Exhausted: the office’s month on its own key, budget admin',
    notice: {
      ...base,
      level: 'exhausted',
      window: 'month',
      unit: 'token',
      percent: 100,
      amounts: { used: 50_200_000, limit: 50_000_000 },
      resetsAt: '2026-11-01T00:00:00.000Z',
      canChange: true,
    },
  },
]

function Sample({ title, notice }: { title: string; notice: ChatUsageNotice }): JSX.Element {
  const [dismissed, setDismissed] = useState(false)
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{title}</h2>
      <div className="bg-card flex flex-col gap-2 rounded-xl border p-3">
        {dismissed ? (
          <button type="button" className="text-muted-foreground text-left text-xs underline" onClick={() => setDismissed(false)}>
            Dismissed. Show again
          </button>
        ) : (
          <UsageNotice notice={notice} onDismiss={() => setDismissed(true)} />
        )}
        <div className="text-muted-foreground rounded-lg border px-3 py-2.5 text-sm">Ask {PRODUCT_NAME} about this project …</div>
      </div>
    </section>
  )
}

export default function UsageNoticePreview(): JSX.Element {
  return (
    <main className="bg-background mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-lg font-semibold">Chat usage notice</h1>
      {SAMPLES.map((sample) => (
        <Sample key={sample.title} {...sample} />
      ))}
    </main>
  )
}
