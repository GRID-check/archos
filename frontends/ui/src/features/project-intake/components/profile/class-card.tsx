'use client'

import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import type { DerivationReview } from '@/lib/project-intake/types'
import { cn } from '@/lib/utils'
import { buildingNumber, displayValue, keyLabel } from '../../lib/display'
import { leadDerivation, REASON_INPUT_IDS, reasonInputs, shortLabel } from './profile-review'

interface ClassCardProps {
  derivations: readonly DerivationReview[]
  /** Go to the Rückfragen, where a missing input is asked. */
  onAnswer: () => void
}

/**
 * The Gebäudeklasse as a result: the class big and why in one line. Nothing to
 * click to confirm it: „Alles übernehmen und abschließen“ in the footer takes
 * it with the values it rests on, and changing an input changes it. How it was
 * worked out (every input, which ones only suggested, the Fundstelle) folds
 * open under „Wie gerechnet?". With several Bauwerke a switch picks which
 * one's class is shown; a Hochhaus has none, and a class still open says
 * what it lacks and where that is asked.
 */
export function ClassCard({ derivations, onAnswer }: ClassCardProps): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const tIntake = useTranslations('projectIntake')
  const lead = leadDerivation(derivations)
  const [chosen, setChosen] = useState<string | null>(null)
  const derivation = derivations.find((candidate) => candidate.buildingId === chosen) ?? lead
  return (
    <section
      aria-label={t('class.label')}
      className="bg-card border-border flex min-w-0 flex-col justify-center gap-3 rounded-[14px] border px-4 py-4 md:px-[22px] md:py-5"
      data-testid="profile-class"
    >
      {derivation ? (
        <ClassResult
          derivation={derivation}
          onAnswer={onAnswer}
          switcher={
            derivations.length > 1 ? (
              <ToggleGroup
                type="single"
                size="sm"
                segmented
                value={derivation.buildingId}
                onValueChange={(value) => value && setChosen(value)}
                aria-label={t('class.buildings')}
                className="shrink-0"
              >
                {derivations.map((candidate) => (
                  <ToggleGroupItem key={candidate.buildingId} value={candidate.buildingId} className="h-7 px-2 text-xs">
                    {tIntake('derivations.building', { number: buildingNumber(candidate.buildingId) })}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : null
          }
        />
      ) : (
        <div className="flex items-center gap-4 md:gap-5">
          <ClassTile value={null} />
          <div className="min-w-0">
            <p className="text-base font-semibold">{t('class.open')}</p>
            <p className="text-muted-foreground mt-1 text-[13px] leading-snug">{t('class.none')}</p>
          </div>
        </div>
      )}
    </section>
  )
}

/** The big tile: ink for a class, quiet while it is open. */
function ClassTile({ value, highRise = false }: { value: number | null; highRise?: boolean }): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const known = value !== null || highRise
  return (
    <div
      aria-hidden
      className={cn(
        'flex size-[72px] shrink-0 flex-col items-center justify-center rounded-2xl md:size-[84px]',
        known ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground border-border border border-dashed',
      )}
    >
      {!highRise && <span className="text-[11px] tracking-[0.06em] opacity-70">{t('class.eyebrow')}</span>}
      <span className="text-[30px] font-semibold leading-none md:text-4xl">
        {highRise ? t('class.highRiseTile') : (value ?? '–')}
      </span>
    </div>
  )
}

function useReason(derivation: DerivationReview): string {
  const t = useTranslations('intakeProfileStep')
  if (derivation.highRise) return t('class.highRiseReason')
  if (derivation.value === null) {
    if (derivation.missing.length === 0) return t('class.none')
    return t('class.missing', { inputs: derivation.missing.map((key) => shortLabel(keyLabel(key))).join(', ') })
  }
  return reasonInputs(derivation)
    .map(({ base, key, value }) => {
      if (base === 'units_over_400') {
        return value === true ? t('class.reason.unitOver400') : t('class.reason.unitOver400None')
      }
      return t(`class.reason.${REASON_INPUT_IDS[base]}`, { value: displayValue(key, value) })
    })
    .join(' · ')
}

function ClassResult({
  derivation,
  onAnswer,
  switcher,
}: Omit<ClassCardProps, 'derivations'> & { derivation: DerivationReview; switcher: ReactNode }): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const [open, setOpen] = useState(false)
  const reason = useReason(derivation)
  const suggestion = derivation.suggestion
  const title = derivation.highRise
    ? t('class.highRise')
    : derivation.value === null
      ? t('class.open')
      : t('class.title', { value: derivation.value })
  const unconfirmed = derivation.inputs.filter((input) => input.suggested).length
  const missingAsked = derivation.value === null && !derivation.highRise && derivation.missing.length > 0

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`profile-class-${derivation.buildingId}`}>
      <div className="flex items-center gap-4 md:gap-5">
        <ClassTile value={derivation.value} highRise={derivation.highRise} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <p className="text-base font-semibold" data-testid="profile-class-title">
              {title}
            </p>
            {switcher}
          </div>
          <p className="text-muted-foreground mt-1 text-[13px] leading-snug" data-testid="profile-class-reason">
            {reason}
          </p>
          {derivation.value !== null && (
            <p className="text-muted-foreground mt-0.5 text-pretty text-[13px] leading-snug">
              {derivation.citation}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {suggestion?.state === 'confirmed' && (
              <span className="text-success flex items-center gap-1.5 text-xs" data-testid="profile-class-confirmed">
                <Check className="size-3" strokeWidth={3} aria-hidden />
                {t('class.confirmed')}
              </span>
            )}
            {missingAsked && (
              <Button type="button" variant="inline" className="touch-target text-[13px]" onClick={onAnswer}>
                {t('class.answer')}
              </Button>
            )}
            {derivation.inputs.length > 0 && (
              <CollapsibleTrigger asChild>
                <Button type="button" variant="inline" className="text-muted-foreground touch-target text-[13px] font-normal">
                  {open ? t('class.howHide') : t('class.how')}
                </Button>
              </CollapsibleTrigger>
            )}
          </div>
        </div>
      </div>
      <CollapsibleContent data-testid="profile-class-working">
        <div className="border-border mt-4 space-y-2 border-t pt-3 text-[13px]">
          <p className="text-muted-foreground text-[11px] uppercase tracking-[0.06em]">{t('class.inputs')}</p>
          <ul className="space-y-1">
            {derivation.inputs.map((input) => (
              <li key={input.key} className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground min-w-0 truncate">{shortLabel(keyLabel(input.key))}</span>
                <span className="shrink-0 font-medium">
                  {displayValue(input.key, input.value)}
                  {input.suggested && (
                    <span className="text-muted-foreground font-normal"> · {t('class.suggestedMark')}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {suggestion?.state === 'suggested' && unconfirmed > 0 && (
            <p className="text-muted-foreground" data-testid="derivation-unconfirmed-inputs">
              {t('derivations.basedOnSuggested', { count: unconfirmed })}
            </p>
          )}
          <p className="text-muted-foreground text-xs">{derivation.citation}</p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
