'use client'

/**
 * Dev preview for „Mehr" on a phone: the tab bar with its bottom sheet open, as
 * a tap on „Mehr" leaves it. `?scope=org` shows the destinations above a
 * project (the org bar has no „Mehr" tab; the sheet's list is what an org
 * reader would be offered). 404s outside development.
 */

import type { JSX } from 'react'
import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { notFound } from 'next/navigation'
import { PhoneMoreSheet } from '@/components/shell/phone-more-sheet'
import { PhoneTabBar } from '@/components/shell/phone-tab-bar'
import { useShellOverlays } from '@/components/shell/shell-overlays'

export default function PhoneMoreDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()
  const org = useSearchParams()?.get('scope') === 'org'
  const projectId = org ? null : 'demo'
  const pathname = org ? '/app/projects' : '/app/projects/demo/settings/members'
  const setOpen = useShellOverlays((s) => s.setMoreSheetOpen)
  useEffect(() => setOpen(true), [setOpen])
  return (
    <div className="bg-background flex h-dvh flex-col">
      <div className="flex h-14 shrink-0 items-center border-b px-4 text-lg font-semibold">Kaiserstraße 43</div>
      <main className="text-muted-foreground min-h-0 flex-1 p-4 text-sm">Page content</main>
      <PhoneTabBar projectId={projectId} canAccessOfficeShelf canAccessInbox pathname={pathname} />
      <PhoneMoreSheet
        projectId={projectId}
        pathname={pathname}
        authRequired
        canAccessOfficeShelf
        canAccessInbox
        showSkills
        canViewOrganization
        canManageOrganization
        canManagePlatform
      />
    </div>
  )
}
