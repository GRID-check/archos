'use client'

/**
 * Renders a shortcut's notation from {@link KeySegment}s as shared {@link Kbd}
 * keycaps. One renderer for the cheatsheet, the command palette, and picker
 * footers — so a chord / leader / alternative / range never gets a second
 * homemade `<kbd>`.
 */

import * as React from 'react'

import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useTranslations } from '@/i18n'
import { MOD, modifierLabel, type KeySegment } from './shortcuts'

/**
 * The `'mod'` keycap's label, the one every shortcut hint shows: `⌘` on Apple
 * platforms, else the control key as the reader's keyboard prints it („Strg“
 * in German, „Ctrl“ in English). A surface never spells it itself, so a search
 * field and the palette beside it cannot name one key two ways.
 */
export function useModifierLabel(): string {
  const t = useTranslations('shortcuts.cheatsheet')
  const [apple, setApple] = React.useState(false)
  React.useEffect(() => {
    const uaPlatform = (
      window.navigator as Navigator & { userAgentData?: { platform?: string } }
    ).userAgentData?.platform
    setApple(modifierLabel(uaPlatform || window.navigator.platform) === '⌘')
  }, [])
  return apple ? '⌘' : t('controlKey')
}

function Joiner({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex h-6 shrink-0 items-center px-0.5 text-[10.5px] leading-none text-muted-foreground">
      {children}
    </span>
  )
}

export function ShortcutKeys({
  segments,
  mod: modProp,
}: {
  segments: readonly KeySegment[]
  mod?: string
}): React.JSX.Element {
  const t = useTranslations('shortcuts.cheatsheet')
  const platformMod = useModifierLabel()
  const resolvedMod = modProp ?? platformMod

  return (
    <KbdGroup className="shrink-0 whitespace-nowrap">
      {segments.map((segment, index) => {
        if (segment.kind === 'then') return <Joiner key={index}>{t('thenSeparator')}</Joiner>
        if (segment.kind === 'or') return <Joiner key={index}>{t('orSeparator')}</Joiner>
        if (segment.kind === 'range') return <Joiner key={index}>–</Joiner>
        return (
          <React.Fragment key={index}>
            {segment.caps.map((cap, capIndex) => (
              <Kbd key={capIndex}>{cap === MOD ? resolvedMod : cap}</Kbd>
            ))}
          </React.Fragment>
        )
      })}
    </KbdGroup>
  )
}
