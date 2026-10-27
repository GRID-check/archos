'use client'

/**
 * Dev preview for the office-wide search INSIDE the app's frame: the real
 * shell chrome (`AppShellChrome`: the org header, the phone tab bar, the
 * frame's one scroller) around the body `/app/search` renders, `ShellContent`
 * with the page header and the URL-driven `SearchWorkspace`. `/app/search`
 * itself needs a WorkOS session; this route does not, and it is what a capture
 * of the page in the shell takes.
 *
 * What differs from the real page: the chrome's props are fixtures, not the
 * session's (an organization, a user, no projects), the path is
 * `/dev/search-shell`, so no header entry is marked current, and the search
 * calls `/api/search` like the page does, so a capture answers it (the
 * screenshot script routes it to the fixture answer). The page's title is
 * the dictionary's, as the server page reads it.
 */

import type { JSX } from 'react'
import { Suspense } from 'react'

import { AppShellChrome } from '@/components/shell/app-shell-chrome'
import { ShellContent } from '@/components/shell/shell-content'
import { PageHeader } from '@/components/ui/page-header'
import { SearchWorkspace } from '@/features/search'
import { NO_TOURS } from '@/lib/onboarding/product-tour'
import { I18nProvider, useTranslations } from '@/i18n'
import { searchCopy } from '@/i18n/namespaces/search'

function SearchPageBody(): JSX.Element {
  const t = useTranslations(searchCopy)
  return (
    <ShellContent width="tool">
      <PageHeader className="mb-6" title={t('title')} />
      <Suspense fallback={null}>
        <SearchWorkspace surface={{ kind: 'office' }} currentUserId="user_lena" autoFocus />
      </Suspense>
    </ShellContent>
  )
}

export default function SearchShellPreview(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <AppShellChrome
        projects={[]}
        user={{ name: 'Lena Huber', email: 'lena.huber@example.at' }}
        organizationName="Musterarchitektur ZT GmbH"
        authRequired={false}
        canManageOrganization
        canViewOrganization
        canManagePlatform={false}
        canAccessOfficeShelf
        canAccessInbox
        showSkills={false}
        showModels={false}
        tours={NO_TOURS}
        overlay={null}
      >
        {/* The `(shell)` layout's own `<main>`, as it sets it. */}
        <main id="main-content" tabIndex={-1} className="bg-background relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto outline-none">
          <SearchPageBody />
        </main>
      </AppShellChrome>
    </I18nProvider>
  )
}
