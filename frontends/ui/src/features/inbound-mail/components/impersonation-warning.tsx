'use client'

/**
 * The warning above a held mail that reads as someone posing as another
 * (`riskLevel: 'impersonation'`): a full-width `Alert` before the header,
 * before anything can be checked, so the first thing read about „Dringend:
 * Kontoänderung Honorarnote“ under a colleague's name is that it is not
 * theirs.
 *
 * It says why (a signature the domain rejected, or a member's name on an
 * address that is not theirs) and what follows: Piloti suggests nothing,
 * nothing is pre-selected, and a payment or bank change is checked by phone,
 * never by replying. No dismiss: the one yes is the bar's acknowledgement.
 *
 * A stop, not a caution: the signal red on the glyph and the leading rule,
 * the words in ink. Not the kit's `Alert variant="destructive"`, whose red
 * text on its tint measures 4.08:1 (axe, 2026-10-22), under the 4.5:1 WCAG
 * AA asks; for the same reason no gold either (`grid-design-language.md`,
 * „Warning gold is a glyph colour“).
 */

import type { JSX } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useTranslations } from '@/i18n'
import type { ImpersonationWarning as Warning } from '../lib/impersonation'

export function ImpersonationWarning({ warning }: { warning: Warning }): JSX.Element {
  const t = useTranslations('inboundMail')
  return (
    <Alert className="border-l-4 border-l-[color:var(--color-signal-error)] [&>svg]:text-error" data-testid="impersonation-warning" data-basis={warning.basis}>
      <ShieldAlert aria-hidden />
      <AlertTitle className="line-clamp-none font-semibold [overflow-wrap:anywhere]">
        {warning.basis === 'member_name'
          ? t('impersonationWarning.memberName', { name: warning.name, address: warning.address })
          : t('impersonationWarning.rejectedSignature', { name: warning.name })}
      </AlertTitle>
      <AlertDescription className="text-foreground">{t('impersonationWarning.consequence')}</AlertDescription>
    </Alert>
  )
}
