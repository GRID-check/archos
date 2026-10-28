'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import { ScanSearch } from 'lucide-react'
import { Chip, ChipLabel } from '@/components/ui/chip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations } from '@/i18n'
import { intakeProfileStepCopy } from '@/i18n/namespaces/intake-profile-step'
import type { ProfileEvidence } from '@/lib/project-intake/types'
import { cn } from '@/lib/utils'
import { EvidenceChips } from '../evidence-chips'
import { ConfidenceNote } from '../intake-atoms'
import { confidenceOf, type Confidence, type ConfidenceSource } from './confidence'
import { hasExcerpt } from './excerpt-loader'
import { PageExcerpt } from './page-excerpt'

/** The words for a confidence, from the step's own namespace. */
export function useConfidenceLabel(): (confidence: Confidence) => string {
  const t = useTranslations(intakeProfileStepCopy)
  return (confidence) => {
    if (confidence.level === 'confirmed') return confidence.ownAnswer ? t('confidence.ownAnswer') : t('confidence.confirmed')
    if (confidence.level === 'contested' || confidence.level === 'corroborated') {
      return t(`confidence.${confidence.level}`, { count: confidence.count })
    }
    return t(`confidence.${confidence.level}`)
  }
}

/**
 * Everything that says why a value is believed, under the value: how sure it
 * is in words, where it was found (the chips open the document at the page),
 * and the excerpt of that page („Belegt statt behauptet“). The excerpt is the
 * first cited PDF page's, shown on demand, or from the start for a value the
 * person is asked to decide on its own (`excerptOpen`), where reading the
 * Fundstelle is the point.
 */
export function ValueEvidence({
  item,
  evidence = item.evidence,
  confidence = confidenceOf(item),
  excerptOpen = false,
  className,
}: {
  item: ConfidenceSource
  /** The evidence to show, when it is not the item's own (an alternative's). */
  evidence?: readonly ProfileEvidence[]
  confidence?: Confidence | null
  excerptOpen?: boolean
  className?: string
}): JSX.Element {
  const t = useTranslations(intakeProfileStepCopy)
  const label = useConfidenceLabel()
  const [open, setOpen] = useState(excerptOpen)
  const cited = evidence.find(hasExcerpt)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('min-w-0 space-y-2', className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        {confidence && (
          <ConfidenceNote level={confidence.level} label={label(confidence)} ownAnswer={confidence.ownAnswer} />
        )}
        <EvidenceChips evidence={evidence} />
        {cited && (
          <CollapsibleTrigger asChild>
            <Chip
              asChild
              interactive
              variant="outline"
              size="sm"
              aria-label={t(open ? 'excerpt.hideAria' : 'excerpt.showAria', { name: cited.fileName, page: cited.page })}
            >
              <button type="button" data-testid="page-excerpt-toggle">
                <ScanSearch aria-hidden />
                <ChipLabel>{t('excerpt.show')}</ChipLabel>
              </button>
            </Chip>
          </CollapsibleTrigger>
        )}
      </div>
      {cited && (
        <CollapsibleContent>
          <PageExcerpt evidence={cited} />
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}
