'use client'

/**
 * The phone's bottom tab bar: the daily destinations under the thumb.
 *
 * WHAT IT IS. A row of four or five tabs, icon over label, pinned to the bottom
 * of the shell below `md`. Which tabs, and why those, is `phone-tabs.ts`. "Mehr"
 * opens the same drawer the rail becomes on a phone, so nothing the rail
 * offers is lost, only moved one tap further.
 *
 * WHY IN FLOW AND NOT FIXED. The bar is the last child of the shell column,
 * after `<main>`, not a `position: fixed` layer over it. `<main>` is the scroll
 * container and simply ends where the bar begins, so no page can scroll content
 * under it, no page has to reserve its height, and a page that forgot to is
 * not a bug waiting to happen. The bar owns the home-indicator inset; while it
 * stands, the shell publishes `--shell-inset-bottom: 0px` so a composer above
 * it does not pad for an inset it no longer touches (`AppShellChrome`).
 *
 * WHEN IT STANDS DOWN. While the on-screen keyboard is up (`useKeyboardUp`), on the intake
 * wizard (`phoneTabBarHiddenOnRoute`), and at `md` and up, where the rail
 * stands instead. Full-screen overlays (the Postfach, the Büroablage, a dialog)
 * cover it on their own; hiding it under them would reflow the page for
 * nothing.
 *
 * LOOK. Ink, never colour: the current tab's glyph sits on the same raised
 * white chip the rail's active entry wears, and the chip glides between tabs on
 * `springGlide`, because where it came from is the one thing a reader needs to
 * see. Short-height screens (a phone on its side) lay icon and label side by
 * side in a 44px row, so the bar costs as little of 393px as a target allows.
 */

import type { JSX } from 'react'
import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { motion, springGlide } from '@/components/motion'
import { FOCUS_RING_INSET } from '@/components/ui/focus-ring'
import { PRESSABLE } from '@/components/ui/press'
import { InboxBadge } from '@/features/collaboration/components'
import { useInboxBadge } from '@/features/collaboration/hooks/use-inbox'
import { useLayoutStore } from '@/features/layout/store'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { orgPhoneTabs, projectPhoneTabs, type PhoneTab, type PhoneTabLabel } from './phone-tabs'

export interface PhoneTabBarProps {
  /** The project whose sections the bar carries, or null above a project. */
  projectId: string | null
  canAccessArchiv: boolean
  canAccessInbox: boolean
  className?: string
  /**
   * The route to light a tab for. The product omits it and the bar reads the
   * URL; a `/dev` preview pins the route it is standing in for.
   */
  pathname?: string
}

export function PhoneTabBar({
  projectId,
  canAccessArchiv,
  canAccessInbox,
  className,
  pathname: pinnedPathname,
}: PhoneTabBarProps): JSX.Element {
  const currentPathname = usePathname() ?? ''
  const pathname = pinnedPathname ?? currentPathname
  const t = useTranslations('nav')
  const tCollaboration = useTranslations('collaboration')
  // The badge subscription only where the bar is seen: at `md` and up the rail
  // or the org header already holds one, and the bar is `display: none`.
  const isMobile = useIsMobile()
  const { pending } = useInboxBadge(canAccessInbox && isMobile)
  const drawerOpen = useLayoutStore((s) => s.isMobileNavOpen)
  const setDrawerOpen = useLayoutStore((s) => s.setMobileNavOpen)
  // One shared-layout id per mounted bar, never a module constant: the scopes
  // preview mounts two bars at once, and a constant would fly the chip
  // between them.
  const pillId = `phone-tab-pill-${React.useId()}`

  const flags = { canAccessArchiv, canAccessInbox }
  const tabs = projectId
    ? projectPhoneTabs(projectId, pathname, flags)
    : orgPhoneTabs(pathname, flags)
  const label = (value: PhoneTabLabel): string =>
    value.namespace === 'collaboration' ? tCollaboration(value.key) : t(value.key)

  return (
    <nav
      aria-label={t('tabBar.label')}
      data-slot="phone-tab-bar"
      data-scope={projectId ? 'project' : 'org'}
      className={cn(
        'border-border w-full shrink-0 border-t md:hidden',
        // The chrome takes its scope's surface, like the header above it:
        // sunken inside a project (the rail's material), paper above one.
        projectId ? 'bg-surface-sunken' : 'bg-background',
        'pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
        className
      )}
    >
      <ul className="mx-auto flex max-w-lg items-stretch px-1">
        {tabs.map((tab) => (
          <li key={tab.key} className="min-w-0 flex-1">
            <PhoneTabItem
              tab={tab}
              label={label(tab.label)}
              pillId={pillId}
              badgeCount={tab.key === 'inbox' ? pending : 0}
              expanded={tab.key === 'more' ? drawerOpen : undefined}
              onOpenMore={() => setDrawerOpen(true)}
            />
          </li>
        ))}
      </ul>
    </nav>
  )
}

function PhoneTabItem({
  tab,
  label,
  pillId,
  badgeCount,
  expanded,
  onOpenMore,
}: {
  tab: PhoneTab
  label: string
  pillId: string
  badgeCount: number
  expanded?: boolean
  onOpenMore: () => void
}): JSX.Element {
  const Icon = tab.icon
  const className = cn(
    'relative flex h-[3.25rem] w-full flex-col items-center justify-center gap-1 rounded-lg outline-none',
    // A phone on its side: icon beside label, one 44px row.
    '[@media(max-height:31rem)]:h-11 [@media(max-height:31rem)]:flex-row [@media(max-height:31rem)]:gap-2',
    PRESSABLE,
    FOCUS_RING_INSET,
    tab.active ? 'text-foreground' : 'text-muted-foreground'
  )
  const body = (
    <>
      <span className="relative flex h-7 w-12 shrink-0 items-center justify-center">
        {tab.active && (
          <motion.span
            layoutId={pillId}
            data-slot="phone-tab-pill"
            aria-hidden
            // The rail's active chip, at the size of one glyph: the same
            // material says the same thing on both shapes of the chrome.
            className="border-border bg-card shadow-xs absolute inset-0 rounded-full border"
            transition={springGlide}
          />
        )}
        <Icon aria-hidden className="relative size-[1.125rem]" />
        <InboxBadge pending={badgeCount} className="absolute -right-0.5 -top-1.5" />
      </span>
      <span
        data-slot="phone-tab-label"
        className={cn(
          'relative max-w-full truncate px-0.5 text-[11px] leading-none tracking-[0.005em]',
          '[@media(max-height:31rem)]:text-xs',
          tab.active ? 'font-semibold' : 'font-medium'
        )}
      >
        {label}
      </span>
    </>
  )

  if (tab.href === null) {
    return (
      <button
        type="button"
        onClick={onOpenMore}
        aria-expanded={expanded}
        aria-haspopup="dialog"
        data-tour={tab.tourAnchor}
        data-tour-placement="above"
        data-state={tab.active ? 'active' : 'inactive'}
        className={className}
      >
        {body}
      </button>
    )
  }

  return (
    <Link
      href={tab.href}
      aria-current={tab.active ? 'page' : undefined}
      data-tour={tab.tourAnchor}
      data-tour-placement="above"
      data-state={tab.active ? 'active' : 'inactive'}
      className={className}
    >
      {body}
    </Link>
  )
}
