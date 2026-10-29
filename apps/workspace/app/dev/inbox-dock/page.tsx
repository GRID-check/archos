'use client'

/**
 * Dev preview of the Postfach docked beside the page (ADR-0153): the real
 * shell (`AppShellChrome`) with the real `InboxDock` in its start slot, served
 * by the shared fixture inbox. No backend, so the page beside the dock is a
 * stand-in that says what goes there; in the product it is the entry's own
 * place, the chat at the message or the review at the mark.
 *
 * `?dock=closed` shows the same shell with the dock put away, which is how a
 * reader without it sees the page.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { AppShellChrome } from '@/components/shell/app-shell-chrome'
import { useStartDock } from '@/components/shell/start-dock'
import { InboxDock } from '@/features/collaboration/components'
import { NO_TOURS } from '@/lib/onboarding/product-tour'
import { installInboxShim } from '../_fixtures/inbox-items'

installInboxShim()

export default function InboxDockPreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()

  // Opened after mount, as a reader's click would: the server renders the dock closed.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('dock') !== 'closed') useStartDock.getState().open('inbox')
    setReady(true)
  }, [])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <AppShellChrome
        projects={[]}
        user={{ name: 'Miriam Hofer', email: 'miriam@buero.at' }}
        organizationName="Architekturbüro Nord"
        authRequired={false}
        canManageOrganization={false}
        canViewOrganization={false}
        canManagePlatform={false}
        canAccessOfficeShelf
        canAccessInbox
        showSkills={false}
        showModels={false}
        tours={NO_TOURS}
        overlay={null}
        startDock={ready ? { inbox: <InboxDock /> } : {}}
      >
        <main id="main-content" className="bg-background relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="m-auto max-w-md space-y-2 p-8 text-center" data-testid="inbox-dock-page">
            <p className="text-sm font-semibold">Hier steht die Seite, die ein Eintrag öffnet</p>
            <p className="text-sm text-muted-foreground">
              Der Chat an der Nachricht oder die Prüfansicht an der Anmerkung, mit allem, was sie können. Das Postfach bleibt daneben.
            </p>
          </div>
        </main>
      </AppShellChrome>
    </I18nProvider>
  )
}
