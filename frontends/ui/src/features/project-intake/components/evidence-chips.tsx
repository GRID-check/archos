'use client'

import type { JSX } from 'react'
import { Calculator, FileText, MapPin, UserRound } from 'lucide-react'
import { Chip, ChipLabel } from '@/components/ui/chip'
import { HoverPeekPanel } from '@/components/ui/hover-peek-panel'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import { useTranslations } from '@/i18n'
import type { ProfileEvidence } from '@/lib/project-intake/types'
import { cn } from '@/lib/utils'

/**
 * Where a value was found, as chips: „Baubeschreibung.pdf, S. 3" with the quote
 * on hover or focus (a tap pins it), the address search, a derivation, or the
 * person's own answer. A value with no evidence shows no chip, never an empty
 * one. Only a document has a passage to show, so only its chip is a control.
 */
export function EvidenceChips({
  evidence,
  className,
}: {
  evidence: readonly ProfileEvidence[]
  className?: string
}): JSX.Element | null {
  if (evidence.length === 0) return null
  return (
    <ul className={cn('flex min-w-0 flex-wrap gap-1.5', className)} data-testid="evidence-chips">
      {evidence.map((entry, index) => (
        <li key={`${entry.kind}-${index}`} className="min-w-0 max-w-full">
          <EvidenceChip evidence={entry} />
        </li>
      ))}
    </ul>
  )
}

function EvidenceChip({ evidence }: { evidence: ProfileEvidence }): JSX.Element {
  const t = useTranslations('projectIntake')
  if (evidence.kind === 'document') return <DocumentChip evidence={evidence} />
  if (evidence.kind === 'geocoder') {
    return (
      <Chip variant="muted" title={evidence.label}>
        <MapPin aria-hidden />
        <ChipLabel>{t('evidence.geocoder')}</ChipLabel>
      </Chip>
    )
  }
  if (evidence.kind === 'derivation') {
    return (
      <Chip variant="muted" title={evidence.citation}>
        <Calculator aria-hidden />
        <ChipLabel>{t('evidence.derivation')}</ChipLabel>
      </Chip>
    )
  }
  return (
    <Chip variant="muted">
      <UserRound aria-hidden />
      <ChipLabel>{t('evidence.person')}</ChipLabel>
    </Chip>
  )
}

function DocumentChip({ evidence }: { evidence: Extract<ProfileEvidence, { kind: 'document' }> }): JSX.Element {
  const t = useTranslations('projectIntake')
  const peek = useHoverPopover()
  const label =
    evidence.page === null
      ? t('evidence.documentNoPage', { name: evidence.fileName })
      : t('evidence.document', { name: evidence.fileName, page: evidence.page })
  return (
    <>
      <Chip asChild variant="muted" interactive>
        <button
          type="button"
          {...peek.triggerProps}
          aria-label={t('evidence.openQuote', { name: label })}
          title={label}
        >
          <FileText aria-hidden />
          <ChipLabel>{label}</ChipLabel>
        </button>
      </Chip>
      <HoverPeekPanel peek={peek} className="w-80 p-3">
        <p className="text-muted-foreground mb-1.5 text-xs">{t('evidence.quote')}</p>
        <blockquote className="border-border border-l-2 pl-3 text-sm leading-relaxed italic">
          {evidence.quote}
        </blockquote>
        <p className="text-muted-foreground mt-2 truncate text-xs">{label}</p>
      </HoverPeekPanel>
    </>
  )
}
