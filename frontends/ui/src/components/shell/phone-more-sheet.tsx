'use client'

/**
 * „Mehr" on a phone: a bottom sheet with the destinations the tab bar does not
 * carry, and the account.
 *
 * It used to open the whole rail as a drawer, which repeated the bar's own four
 * tabs and made the tab feel pointless. What is listed is `moreDestinations`
 * (derived from the bar's tab list and the rail's gates, never a second list).
 * Rows are 56px, the current page is marked, and the actions that were behind
 * the avatar (appearance, language, tour, feedback, sign out) sit below the
 * destinations. The project switcher stays on the header pill.
 */

import type { JSX } from 'react'
import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Check, ChevronRight, Compass, LogOut, MessageSquarePlus } from 'lucide-react'

import { useAuth } from '@/adapters/auth/use-auth'
import { FOCUS_RING_INSET } from '@/components/ui/focus-ring'
import { PRESSABLE } from '@/components/ui/press'
import { SectionLabel } from '@/components/ui/section-label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useLayoutStore } from '@/features/layout/store'
import type { ThemeMode } from '@/features/layout/types'
import { useStartProductTour } from '@/features/onboarding/components/product-tour'
import { useFeedbackAvailable, useOpenFeedback } from '@/features/product-feedback/components'
import { locales, useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { isCurrentDestination, moreDestinations, type MoreDestination, type MoreFlags } from './phone-more'
import { useShellOverlays } from './shell-overlays'

const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark']

const ROW =
  'flex min-h-14 w-full items-center gap-3 px-4 text-left text-sm outline-none active:bg-accent ' +
  PRESSABLE +
  ' ' +
  FOCUS_RING_INSET

export interface PhoneMoreSheetProps extends MoreFlags {
  /** The project the bar is for, or null above a project. */
  projectId: string | null
  authRequired: boolean
  /** The route to mark current; the product omits it and the sheet reads the URL. */
  pathname?: string
}

export function PhoneMoreSheet({
  projectId,
  authRequired,
  pathname: pinnedPathname,
  ...flags
}: PhoneMoreSheetProps): JSX.Element {
  const t = useTranslations('nav')
  const tc = useTranslations('common')
  const tCollaboration = useTranslations('collaboration')
  const tFeedback = useTranslations('feedback')
  const currentPathname = usePathname() ?? ''
  const pathname = pinnedPathname ?? currentPathname
  const open = useShellOverlays((s) => s.moreSheetOpen)
  const setOpen = useShellOverlays((s) => s.setMoreSheetOpen)
  const { signOut } = useAuth()
  const theme = useLayoutStore((s) => s.theme)
  const setTheme = useLayoutStore((s) => s.setTheme)
  const { locale, setLocale, localeNames } = useLocale()
  const startTour = useStartProductTour()
  const openFeedback = useOpenFeedback()
  const feedbackAvailable = useFeedbackAvailable()

  // A navigation closes the sheet, as it does the drawer.
  React.useEffect(() => {
    setOpen(false)
  }, [pathname, setOpen])

  const destinations = moreDestinations(projectId, pathname, flags)
  const label = (destination: MoreDestination): string =>
    destination.label.namespace === 'collaboration'
      ? tCollaboration(destination.label.key)
      : t(destination.label.key)
  const places = destinations.filter((destination) => destination.group === 'places')
  const account = destinations.filter((destination) => destination.group === 'account')
  const act = (run: () => void) => (): void => {
    setOpen(false)
    run()
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="bottom"
        closeLabel={t('tabBar.moreSheet.close')}
        data-slot="phone-more-sheet"
        className={cn(
          'max-h-[85dvh] gap-0 overflow-hidden rounded-t-xl p-0 outline-none',
          'pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]'
        )}
      >
        <div aria-hidden className="bg-border mx-auto mt-2 h-1 w-9 shrink-0 rounded-full" />
        <SheetHeader className="shrink-0 gap-0.5 px-4 pb-2 pt-3">
          <SheetTitle className="text-base font-semibold tracking-tight">{t('tabBar.moreSheet.title')}</SheetTitle>
          <SheetDescription className="sr-only">{t('tabBar.moreSheet.description')}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
          {places.length > 0 && (
            <Group label={t('tabBar.moreSheet.places')}>
              {places.map((destination) => (
                <DestinationRow
                  key={destination.key}
                  destination={destination}
                  label={label(destination)}
                  current={isCurrentDestination(destination, pathname)}
                  onNavigate={() => setOpen(false)}
                />
              ))}
            </Group>
          )}
          <Group label={t('tabBar.moreSheet.account')}>
            {account.map((destination) => (
              <DestinationRow
                key={destination.key}
                destination={destination}
                label={label(destination)}
                current={isCurrentDestination(destination, pathname)}
                onNavigate={() => setOpen(false)}
              />
            ))}
            <li className="flex min-h-14 items-center gap-3 px-4">
              <span className="min-w-0 flex-1 text-sm">{tc('theme.label')}</span>
              <Segmented
                ariaLabel={tc('theme.label')}
                value={theme}
                options={THEME_MODES.map((mode) => ({ value: mode, label: tc(`theme.${mode}`) }))}
                onChange={(mode) => setTheme(mode as ThemeMode)}
              />
            </li>
            <li className="flex min-h-14 items-center gap-3 px-4">
              <span className="min-w-0 flex-1 text-sm">{tc('language.label')}</span>
              <Segmented
                ariaLabel={tc('language.label')}
                value={locale}
                options={locales.map((code) => ({ value: code, label: localeNames[code] }))}
                onChange={(code) => setLocale(code as typeof locale)}
              />
            </li>
            <li>
              <button type="button" className={ROW} onClick={act(() => startTour())}>
                <Compass className="text-muted-foreground size-5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{t('userMenu.productTour')}</span>
              </button>
            </li>
            {feedbackAvailable && (
              <li>
                <button type="button" className={ROW} onClick={act(() => openFeedback())}>
                  <MessageSquarePlus className="text-muted-foreground size-5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">{tFeedback('open')}</span>
                </button>
              </li>
            )}
            {authRequired && (
              <li>
                <button type="button" className={ROW} onClick={act(() => void signOut())}>
                  <LogOut className="text-muted-foreground size-5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">{tc('actions.signOut')}</span>
                </button>
              </li>
            )}
          </Group>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  const id = React.useId()
  return (
    <section aria-labelledby={id} className="pt-1">
      <SectionLabel as="h3" id={id} className="block px-4 pb-1 pt-2">
        {label}
      </SectionLabel>
      <ul>{children}</ul>
    </section>
  )
}

function DestinationRow({
  destination,
  label,
  current,
  onNavigate,
}: {
  destination: MoreDestination
  label: string
  current: boolean
  onNavigate: () => void
}): JSX.Element {
  const Icon = destination.icon
  return (
    <li>
      <Link
        href={destination.href}
        onClick={onNavigate}
        aria-current={current ? 'page' : undefined}
        data-destination={destination.key}
        className={ROW}
      >
        <Icon aria-hidden className="text-muted-foreground size-5 shrink-0" />
        <span className={cn('min-w-0 flex-1', current && 'font-semibold')}>{label}</span>
        {current ? (
          <Check className="size-4 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
        )}
      </Link>
    </li>
  )
}

/** A short choice as a row of 44px buttons: the value is visible, one tap changes it. */
function Segmented({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <div role="group" aria-label={ariaLabel} className="bg-muted flex shrink-0 gap-0.5 rounded-lg p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'min-h-11 min-w-11 rounded-md px-2.5 text-xs font-medium outline-none',
            FOCUS_RING_INSET,
            option.value === value ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
