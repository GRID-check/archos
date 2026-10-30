'use client'

/**
 * Dev preview for a SHARED chat thread — the real `ChatArea` driven by the real
 * `useSharedThread` seam (ADR-0033), with a module-scope fetch shim standing in
 * for the BFF so the surface is reproducible with no backend and no database.
 *
 * What it is evidence of, in one screen (spec CC-4, CC-5, CC-13, CC-19):
 *   - three people plus the agent in one thread, each human message attributed
 *     with an avatar + name (the reader's own reading "Sie"/"You");
 *   - **grouping**: Anna's two consecutive messages share one header, the second
 *     aligned under it;
 *   - all four voices distinguishable at a glance WITHOUT messenger left/right:
 *     every human message keeps the same right-hand card bubble (a colleague's and
 *     your own differ only by the avatar + name header), while the agent's answer
 *     is the full-width Ergebnis card and its status output is the Herleitung
 *     spine — so Piloti stays the dominant, central voice in the column;
 *   - the **unread separator** at the point the reader left off;
 *   - the **turn-in-flight banner**: the agent is answering Anna's question, which
 *     is what stops the wait reading as nothing happening.
 *
 * Variants via `?variant=`:
 *   - default     — the above.
 *   - `live`      — the same thread with liveness ON (ADR-0039): the observer is
 *                   WATCHING Tobias's turn — the reasoning chain building and the
 *                   answer streaming in, not a spinner — while Anna is composing
 *                   alongside it. The two live signals are deliberately different
 *                   shapes: the agent gets the Piloti glyph and the shimmer, a
 *                   colleague gets their avatar and three dots.
 *   - `handback`  — the resolution point of a hand-off (ADR-0034 addendum): the
 *                   reader asked Anna, Anna has answered, the wait is closed, and
 *                   the thread offers to let Piloti carry on. The one transition
 *                   that used to have no affordance at all, because the awaiting
 *                   banner disappears the moment it becomes relevant. Its action
 *                   pre-fills the composer — which this preview does not mount — so
 *                   here it only steps aside; the composer end is at
 *                   `/dev/composer-addressee`.
 *
 * The shim is installed at module scope — before any effect can fire — so the
 * hook's first fetch already sees the fixture. Browser + development only, and
 * idempotent, matching `dev/document-grid/page.tsx`.
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
import { I18nProvider } from '@/i18n'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { ChatArea } from '@/features/layout/components'
import { installSharedThreadShim, seedSharedThread } from '../_fixtures/shared-thread'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

installSharedThreadShim()

export default function SharedThreadPreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Seeded after mount so the server and the first client render agree.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    seedSharedThread()
    setReady(true)
  }, [])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <AppConfigProvider config={config}>
        <main className="bg-background flex h-dvh flex-col" data-testid="shared-thread-preview">
          {ready && <ChatArea isAuthenticated canCollaborate />}
        </main>
      </AppConfigProvider>
    </I18nProvider>
  )
}
