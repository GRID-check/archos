'use client'

/**
 * Dev preview for Platform → one organization's spend
 * (`app/app/(shell)/platform/organizations/[id]`): the REAL view, fed by a
 * fetch shim for its one endpoint, so it can be reviewed and screenshotted
 * without a backend or a platform session. Eight models with one over the
 * palette (the tail folds into "Other"), a month near its limit, and a member
 * WorkOS no longer lists.
 *
 *   /dev/platform-org-usage   404s outside development (see `../layout.tsx`)
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'

import { PlatformOrgUsageView } from '../../app/(shell)/platform/organizations/[id]/platform-org-usage'

const spend = (amount: number, events: number) => ({ amount, events })

const MODELS = [
  { model: 'anthropic/claude-haiku-5.5', day: spend(310, 260), month: spend(5120, 4410) },
  { model: 'openai/gpt-6-sol', day: spend(180, 22), month: spend(2390, 310) },
  { model: 'google/gemini-3.0-pro', day: spend(40, 8), month: spend(610, 120) },
  { model: 'typesafe/jev-1.13', day: spend(12, 90), month: spend(220, 1800) },
  { model: 'openai/gpt-6-luna', day: spend(3, 4), month: spend(40, 61) },
  { model: 'mistralai/mistral-large-3', day: spend(0, 0), month: spend(30, 9) },
  { model: 'deepseek/deepseek-v4', day: spend(0, 0), month: spend(12, 4) },
  { model: 'qwen/qwen3-235b', day: spend(0, 0), month: spend(8, 2) },
  { model: 'x-ai/grok-4', day: spend(1, 1), month: spend(5, 3) },
]

const sum = (pick: (m: (typeof MODELS)[number]) => { amount: number; events: number }) =>
  spend(
    MODELS.reduce((total, m) => total + pick(m).amount, 0),
    MODELS.reduce((total, m) => total + pick(m).events, 0),
  )

const DAILY_TREND = Array.from({ length: 30 }, (_, index) => {
  const day = new Date(Date.UTC(2026, 8, 21))
  day.setUTCDate(day.getUTCDate() + index)
  const weekend = index % 7 === 5 || index % 7 === 6
  const amount = weekend ? 20 : 180 + (index % 5) * 60 + (index > 22 ? 200 : 0)
  return { day: day.toISOString().slice(0, 10), amount, events: weekend ? 6 : 140 + (index % 4) * 30 }
})

const RESPONSE = {
  organization: { id: 'org_preview', name: 'feld72 Architekten ZT GmbH' },
  usage: {
    unit: 'credit',
    summary: { day: sum((m) => m.day), month: sum((m) => m.month), perModel: MODELS },
    perMember: [
      { userId: 'user_01', day: spend(320, 180), month: spend(4210, 2900) },
      { userId: 'user_02', day: spend(160, 120), month: spend(2380, 2100) },
      { userId: 'user_03', day: spend(66, 85), month: spend(1640, 1400) },
      { userId: 'user_gone', day: spend(0, 0), month: spend(205, 300) },
    ],
    dailyTrend: DAILY_TREND,
    orgBudget: { dailyLimit: 1000, monthlyLimit: 10000, explicit: true },
    status: { blocked: false, blockedScope: null },
    scope: {},
  },
  members: [
    { id: 'user_01', email: 'anna.berger@bauwerk.test', name: 'Anna Berger' },
    { id: 'user_02', email: 'tom.hofer@bauwerk.test', name: 'Tom Hofer' },
    { id: 'user_03', email: 'lea.mayr@bauwerk.test', name: null },
  ],
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformOrgUsageShim?: boolean }
  if (!w.__platformOrgUsageShim) {
    w.__platformOrgUsageShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/platform/organizations/org_preview/usage')) return Response.json(RESPONSE)
      return real(input, init)
    }
  }
}

export default function PlatformOrgUsageDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-8" data-testid="platform-org-usage-preview">
      <PlatformOrgUsageView organizationId="org_preview" />
    </main>
  )
}
