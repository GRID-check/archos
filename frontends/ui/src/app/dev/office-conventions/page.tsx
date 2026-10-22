'use client'

/**
 * Dev preview for Organisation → what Piloti has learned about the office
 * (ADR-0129): the real card over a fetch shim with one line of each state, a
 * counted one, a declined one and a confirmed one the latest count no longer
 * shows. Not linked from anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { I18nProvider } from '@/i18n'
import { OfficeConventionsCard } from '@/features/organization/components/office-conventions-card'
import { Card, CardContent } from '@/components/ui/card'
import type { ConventionLine, OfficeConventionsView } from '@/lib/office-conventions/office-conventions-wire'

const line = (l: ConventionLine, decision: 'confirmed' | 'declined' | null, counted = true) => ({
  line: l,
  decision,
  counted,
  decidedBy: decision ? 'user-1' : null,
  decidedAt: decision ? '2026-10-22T08:00:00.000Z' : null,
})

const VIEW: OfficeConventionsView = {
  enabled: true,
  projects: 8,
  computedAt: '2026-10-22T08:00:00.000Z',
  lines: [
    line({ kind: 'filing', key: 'filing:gutachten>behörde', docType: 'Gutachten', path: 'Behörde', projects: 6, of: 7 }, null),
    line({ kind: 'folder', key: 'folder:grundlagen', path: 'Grundlagen', projects: 8, of: 8 }, 'declined'),
    line({ kind: 'file_date', key: 'file_date:YYYYMMDD', format: 'YYYYMMDD', projects: 2, of: 8 }, 'confirmed', false),
  ],
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __officeConventionsShim?: boolean }
  if (!w.__officeConventionsShim) {
    w.__officeConventionsShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/organization/office-conventions') return Response.json(VIEW)
      return real(input, init)
    }
  }
}

export default function OfficeConventionsDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="mx-auto max-w-3xl p-8" data-testid="office-conventions-preview">
        <Card>
          <CardContent>
            <OfficeConventionsCard />
          </CardContent>
        </Card>
      </main>
    </I18nProvider>
  )
}
