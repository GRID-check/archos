/**
 * The office-wide search (ADR-0136, `docs/design/document-search.md`, 08:55):
 * every shelf the reader may open, every kind of thing the office works with.
 * Reached from the rail's „Suche“, the header's magnifier and ⌘K.
 *
 * The question is in the URL (`?q=…&type=…`), so the page is a link; the
 * organism reads it on the client, inside the Suspense boundary
 * `useSearchParams` asks for.
 */

import type { JSX } from 'react'
import { Suspense } from 'react'
import { type Metadata } from 'next'

import { ShellContent } from '@/components/shell/shell-content'
import { PageHeader } from '@/components/ui/page-header'
import { SearchWorkspace } from '@/features/search'
import { getTranslations } from '@/i18n/server'
import { withPageSession } from '@/lib/auth/require-auth'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('search')
  return { title: t('title') }
}

export default async function SearchPage(): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const t = await getTranslations('search')
    return (
      <ShellContent width="wide">
        <PageHeader className="mb-6" title={t('title')} />
        <Suspense fallback={null}>
          <SearchWorkspace surface={{ kind: 'office' }} currentUserId={session.userId} autoFocus />
        </Suspense>
      </ShellContent>
    )
  })
}
