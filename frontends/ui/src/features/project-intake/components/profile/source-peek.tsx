'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import { Calculator, MapPin, UserRound } from 'lucide-react'
import { Chip, ChipLabel } from '@/components/ui/chip'
import { HoverPeekPanel } from '@/components/ui/hover-peek-panel'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import { useTranslations } from '@/i18n'
import type { ProfileEvidence } from '@/lib/project-intake/types'
import { cn } from '@/lib/utils'
import { EvidenceChips } from '../evidence-chips'
import { distinctSources } from './confidence'
import { hasExcerpt, type DocumentEvidence } from './excerpt-loader'
import { PageExcerpt } from './page-excerpt'
import { documentName } from './profile-review'

/** The source a row names: a cited PDF page first, then any document, then whatever there is. */
export function leadEvidence(evidence: readonly ProfileEvidence[]): ProfileEvidence | null {
  return (
    evidence.find(hasExcerpt) ?? evidence.find((entry) => entry.kind === 'document') ?? evidence[0] ?? null
  )
}

const CHIP_CLASS = 'h-7 max-w-full rounded-md px-2 text-xs pointer-coarse:h-8'

/**
 * A value's source on its row: „E-02 Schnitt A-A · S. 1". Pointing at it, or
 * focusing it, shows the page the value stands on, the passage marked, with the
 * quote under it („Belegt statt behauptet“); a click (or a tap) pins it, and a
 * pinned peek offers the document itself, opened at that page in the viewer the
 * chat's citations open. The address search, a derivation and the person's own
 * answer are named, with nothing to peek at.
 */
export function SourcePeek({ evidence, label }: { evidence: readonly ProfileEvidence[]; label: string }): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const lead = leadEvidence(evidence)
  if (!lead) return <span className="text-muted-foreground text-xs">{t('source.none')}</span>
  const more = Math.max(0, distinctSources(evidence) - 1)
  if (lead.kind !== 'document') return <OtherSource evidence={lead} more={more} />
  return <DocumentSource lead={lead} evidence={evidence} label={label} more={more} />
}

function OtherSource({ evidence, more }: { evidence: Exclude<ProfileEvidence, DocumentEvidence>; more: number }): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const [Icon, text, title] =
    evidence.kind === 'geocoder'
      ? [MapPin, t('source.geocoder'), evidence.label]
      : evidence.kind === 'derivation'
        ? [Calculator, t('source.derivation'), evidence.citation]
        : [UserRound, t('source.person'), undefined]
  return (
    <Chip variant="muted" className={CHIP_CLASS} title={title}>
      <Icon aria-hidden />
      <ChipLabel>{text}</ChipLabel>
      {more > 0 && <span className="tabular-nums">{t('source.more', { count: more })}</span>}
    </Chip>
  )
}

function DocumentSource({
  lead,
  evidence,
  label,
  more,
}: {
  lead: DocumentEvidence
  evidence: readonly ProfileEvidence[]
  label: string
  more: number
}): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const peek = useHoverPopover()
  // The hook pins on a click and unpins on the next; this mirrors it so the
  // panel offers the viewer only once pinned. A hovered panel holding a chip
  // with a peek of its own would hand its one slot to that chip and vanish.
  const [clickedPinned, setClickedPinned] = useState(false)
  const pinned = clickedPinned && peek.open
  const name = documentName(lead.fileName)
  const text =
    lead.page === null ? t('source.documentNoPage', { name }) : t('source.document', { name, page: lead.page })
  const triggerProps = {
    ...peek.triggerProps,
    onClick: () => {
      peek.triggerProps.onClick()
      setClickedPinned(!pinned)
    },
  }
  const documents = evidence.filter((entry) => entry.kind === 'document')
  return (
    <>
      <Chip asChild interactive variant="muted" className={cn(CHIP_CLASS, 'aria-expanded:bg-primary aria-expanded:text-primary-foreground')}>
        <button type="button" aria-label={t('source.chipAria', { label, source: text })} data-testid="source-peek" {...triggerProps}>
          <ChipLabel>{text}</ChipLabel>
          {more > 0 && <span className="tabular-nums">{t('source.more', { count: more })}</span>}
        </button>
      </Chip>
      <HoverPeekPanel peek={peek} className="w-80 space-y-2 p-2.5">
        <div data-testid="source-peek-panel" className="space-y-2">
          {hasExcerpt(lead) && <PageExcerpt evidence={lead} className="max-w-none" />}
          <p className="text-muted-foreground px-0.5 text-xs leading-relaxed">„{lead.quote}“</p>
          {pinned ? (
            <div className="space-y-1.5 px-0.5">
              <p className="text-muted-foreground text-[11px] uppercase tracking-[0.06em]">{t('source.open')}</p>
              <EvidenceChips evidence={documents} />
            </div>
          ) : (
            <p className="text-muted-foreground px-0.5 text-[11px]">{t('source.pinHint')}</p>
          )}
        </div>
      </HoverPeekPanel>
    </>
  )
}
