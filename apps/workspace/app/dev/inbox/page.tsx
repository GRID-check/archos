'use client'

/**
 * Dev preview for the inbox surfaces — the real `InboxList`, `InboxItemRow` and
 * `InboxBadge` with fixture data and no backend, so the design can be reviewed
 * and screenshotted (spec NF-10). Not linked from anywhere; 404s outside
 * development.
 *
 * The fetch shim is installed at MODULE SCOPE on purpose: React runs a child's
 * effects before its parent's, so `useInboxList` would fire its request before a
 * parent `useEffect` could install a shim — the shim would race and lose (see
 * `docs/ux/visual-screenshots.md` and `app/dev/document-grid/page.tsx`). It is
 * browser + dev guarded and idempotent via a `window.__inboxShim` flag.
 *
 * The fixtures deliberately exercise every interesting row: an unread actionable
 * mention request, a resolved one, a grouped activity row (`count: 3`), a
 * shared-with-you row, a READ grouped row with `count: 0` (the third counted
 * title — nothing new since it was opened), the OPERATIONAL storage-quota
 * warning (ADR-0042 — no actor, `tone: 'warning'`, pointing at the organization
 * rather than a conversation), a row whose type this build does not know (the
 * runtime fallback that keeps one bad row from taking the page down), and an
 * INERT row whose target is gone — the last one is a security-visible state
 * (IB-13), so it must be in the evidence.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): German is the product's
 * primary language, so the committed evidence must carry the copy most users
 * actually see — and the scaffolding around these previews is German already, so
 * without the pin a screenshot mixes both languages and the primary-language copy
 * cannot be reviewed at all.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { Bell } from 'lucide-react'

import { I18nProvider } from '@/i18n'
import { InboxBadge, InboxList } from '@/features/collaboration/components'
import { installInboxShim, isEmptyVariant } from '../_fixtures/inbox-items'
import { VIEWER_ID } from '../_fixtures/inbox-rows'

installInboxShim()

export default function InboxDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Read after mount (not during render) so server and client markup agree — the
  // same trick the herleitung preview uses. The list is held back until then,
  // because its opening filter depends on the variant: the default view captures
  // EVERYTHING (the inert / answered / grouped rows only exist outside "needs
  // me"), while the empty variant captures the needs-me empty state.
  const [ready, setReady] = useState(false)
  const [empty, setEmpty] = useState(false)
  useEffect(() => {
    setEmpty(isEmptyVariant())
    setReady(true)
  }, [])

  // `text-foreground` matters: the root layout only sets a surface colour, so
  // without it this preview's own headings inherit the browser default and go
  // black in dark mode (product pages set it on their shell wrapper).
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="inbox-preview"
        className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-8 text-foreground md:px-8"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Postfach</h1>
          <p className="mt-1 text-sm text-muted-foreground">Anfragen und Neuigkeiten aus Ihrem Team.</p>
        </div>

        {/* One list, so a single screenshot carries every row treatment. */}
        {/* „Für mich“, the queue, opens it; ?filter=all shows every row treatment in one list. */}
        {ready && <InboxList initialFilter="needsMe" viewerId={VIEWER_ID} />}

        {!empty && (
          <section className="space-y-3">
            <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              Badge
            </h2>
            <div className="flex flex-wrap items-center gap-6">
              {[1, 4, 128].map((count) => (
                <div key={count} className="flex items-center gap-2">
                  <span className="text-[13px] text-muted-foreground">Postfach</span>
                  <InboxBadge pending={count} />
                </div>
              ))}
              {/* Collapsed-rail case: icon tile with the pill in the corner. */}
              <div className="relative flex size-9 items-center justify-center rounded-[10px] border border-border bg-card shadow-xs">
                <Bell className="size-4 text-muted-foreground" aria-hidden />
                <InboxBadge pending={7} className="absolute -top-1 -right-1 shadow-xs" />
              </div>
            </div>
          </section>
        )}
      </main>
    </I18nProvider>
  )
}
