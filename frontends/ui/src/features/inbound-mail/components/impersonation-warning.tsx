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
 * Gold on the glyph, words in ink, a step heavier (`grid-design-language.md`,
 * „Warning gold is a glyph colour“): the kit's `Alert variant="warning"`
 * prints its text in the gold that fails 4.5:1, so this is the default
 * `Alert` with a gold glyph and a gold leading rule.
 */

import type { JSX } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useTranslations } from '@/i18n'
import type { ImpersonationWarning as Warning } from '../lib/impersonation'

export function ImpersonationWarning({ warning }: { warning: Warning }): JSX.Element {
  const t = useTranslations('inboundMail')
  return (
    <Alert className="border-l-warning border-l-4" data-testid="impersonation-warning" data-basis={warning.basis}>
      <ShieldAlert aria-hidden className="text-warning" />
      <AlertTitle className="line-clamp-none font-semibold [overflow-wrap:anywhere]">
        {warning.basis === 'member_name'
          ? t('impersonationWarning.memberName', { name: warning.name, address: warning.address })
          : t('impersonationWarning.rejectedSignature', { name: warning.name })}
      </AlertTitle>
      <AlertDescription className="text-foreground">{t('impersonationWarning.consequence')}</AlertDescription>
    </Alert>
  )
}
