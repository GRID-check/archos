'use client'

/**
 * The touch door into the command palette.
 *
 * The palette (jump to a project, a section, the Büroablage, the organization)
 * opened only on ⌘K, so on a phone it existed and could not be reached. This is
 * the same palette behind a magnifier, in both headers. It writes the flag the
 * chord writes (`useShellOverlays`), so there is one palette with two doors,
 * not a phone search beside a desktop one.
 *
 * 44px on a coarse pointer and 36px on a fine one, the header's other icons'
 * size; `aria-keyshortcuts` names the chord for the reader who has a keyboard.
 */

import type { JSX } from 'react'
import { Search } from 'lucide-react'

import { FOCUS_RING } from '@/components/ui/focus-ring'
import { TOUR_ANCHORS } from '@/features/onboarding/lib/product-tour'
import { useTranslations } from '@/i18n'
import { navCopy } from '@/i18n/namespaces/nav'
import { cn } from '@/lib/utils'
import { useShellOverlays } from './shell-overlays'

export function ShellSearchButton({ className }: { className?: string }): JSX.Element {
  const t = useTranslations(navCopy)
  const open = useShellOverlays((s) => s.paletteOpen)
  const setOpen = useShellOverlays((s) => s.setPaletteOpen)
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={t('search.open')}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-keyshortcuts="Control+K Meta+K"
      data-testid="shell-search"
      data-tour={TOUR_ANCHORS.search}
      className={cn(
        'text-muted-foreground hover:bg-accent hover:text-foreground duration-quick pointer-coarse:size-11 relative flex size-9 shrink-0 items-center justify-center rounded-lg outline-none transition-colors ease-out motion-reduce:transition-none',
        FOCUS_RING,
        className
      )}
    >
      <Search className="size-[1.125rem]" aria-hidden />
    </button>
  )
}
