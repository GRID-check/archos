'use client'

/**
 * CalculationCard — der Rechenweg, laid out line by line.
 *
 * The single thing a Ziviltechniker re-checks. As prose („2 × 17 + 30 = 64 cm,
 * damit innerhalb der Schrittmaßregel") the reader has to re-derive it before
 * they can trust it; here it is a derivation they audit by looking at it.
 *
 * ## Why this card cannot disagree with itself
 *
 * The model supplies operands, an operation and the limit. Everything else on
 * the card is produced HERE, by `../lib/calculate`: every step's result, the
 * tolerance band propagated through it, and the verdict against the limit.
 * There is no `result` field on the wire for a model to state, which is the
 * whole point — a Rechenweg whose printed result disagreed with its own
 * operands would be the worst artefact this product can make, because the card
 * is the part that gets screenshotted into an Einreichung.
 *
 * That extends to how the number is PRINTED. The house format is two decimals
 * (`fmtNum`), which is exact for almost every derivation here; where rounding
 * to it would move the value across the bound, `resultDecimals` prints further
 * instead, so the number on the card and the verdict beside it can never
 * contradict each other (a 0,2504 W/(m²K) against a „≤ 0,25" limit prints as
 * 0,2504, not as „0,25 — nicht erfüllt").
 *
 * The disclosure holds the operands' provenance, their bands and where each
 * figure is written down — the second thing that gets re-checked, and already
 * on the client, so opening it costs no turn („ich klick das und sehe mehr").
 * It is offered only when at least one operand actually carries something
 * behind it: an expander that opens onto nothing teaches the reader the
 * chevrons are decorative.
 *
 * `presentational` in CARD_INTERACTIVITY — opening the sources is one reader's
 * view state, commits nothing and reaches no backend (ADR-0030).
 */

import { useState, type FC } from 'react'
import { ChevronDown, Sigma } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations, type Translator } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import {
  SchematicCard,
  fmtComparator,
  fmtNum,
  fmtTolerance,
  provenanceLabel,
  provenanceTitle,
} from '../schematics/kit'
import { evaluate, formatInput, resultDecimals, verdictFor } from '../lib/calculate'
import { cn } from '@/lib/utils'
import type { CalculationLimitData, CalculationStepData, NormReferenceData } from '@/shared/cards/schemas'
import { DerivationSteps } from './Derivation'

interface CalculationCardProps {
  title: string
  steps: CalculationStepData[]
  limit?: CalculationLimitData | null
  reference?: NormReferenceData | null
  note?: string | null
}

/** The bound the last result is held against, written the way a plan writes it. */
const LimitLine: FC<{ limit: CalculationLimitData; unit: string; t: Translator }> = ({ limit, unit, t }) => {
  const suffix = unit ? ` ${unit}` : ''
  const text =
    limit.comparator === 'between'
      ? t('cards.calculation.limitRange', {
          lower: fmtNum(limit.value),
          upper: fmtNum(limit.upper ?? limit.value),
          unit,
        })
      : `${fmtComparator(limit.comparator)} ${fmtNum(limit.value)}${suffix}`

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {t('cards.calculation.limitLabel')}
      </span>
      <span className="font-mono text-foreground">{text}</span>
      {limit.label && <span className="text-muted-foreground">{limit.label}</span>}
      {limit.reference && (
        <span className="text-muted-foreground">
          {limit.reference.document}
          {limit.reference.section && <span className="ml-1 font-mono">{limit.reference.section}</span>}
        </span>
      )}
    </div>
  )
}

export const CalculationCard: FC<CalculationCardProps> = ({ title, steps, limit, reference, note }) => {
  const t = useTranslations(chatCopy)
  const [open, setOpen] = useState(false)

  const results = evaluate(steps)
  const final = results[results.length - 1]
  const verdict = final ? verdictFor(final, limit) : null
  const decimals = final ? resultDecimals(final, limit) : 2

  // The disclosure is offered only when something is actually behind it. An
  // operand with no provenance, no band and no source has nothing to reveal,
  // and an expander that opens onto a restatement teaches the reader that the
  // chevrons are decorative.
  const documented = steps.flatMap((step) =>
    step.operands.filter((operand) => operand.step == null && (operand.provenance || operand.tolerance || operand.source))
  )

  return (
    <SchematicCard
      icon={Sigma}
      eyebrow={t('cards.calculation.eyebrow')}
      title={title}
      verdict={verdict}
      note={note}
      reference={reference}
    >
      <DerivationSteps
        steps={steps}
        results={results}
        display={steps.map((_, index) => ({ decimals: index === steps.length - 1 ? decimals : 2 }))}
        tint={verdict}
        t={t}
      />

      {limit && <LimitLine limit={limit} unit={final?.unit ?? ''} t={t} />}

      {/* The band reaches over the bound: at this precision the derivation is
          on both sides of the line, and the same sentence the schematics use
          for a straddling measurement says so here. */}
      {verdict === 'warning' && (
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
          {t('cards.kit.toleranceStraddlesLimit')}
        </p>
      )}

      {documented.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className={cn(
              // See CalloutCard: catchment, not padding — the drawn control keeps the
              // card's rhythm and a fingertip still gets its 44px.
              '-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 touch-target',
              'text-xs font-medium text-muted-foreground',
              'transition-colors duration-quick ease-out hover:text-foreground',
              'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2'
            )}
          >
            {open ? t('cards.calculation.sourcesLess') : t('cards.calculation.sourcesMore')}
            <ChevronDown
              className={cn(
                'size-3.5',
                'transition-transform duration-quick ease-out motion-reduce:transition-none',
                open && 'rotate-180'
              )}
              aria-hidden="true"
            />
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="mt-1.5 flex flex-col gap-1.5 pl-3">
              {documented.map((operand, index) => {
                const unit = operand.unit ?? ''
                const band = operand.provenance === 'computed' ? fmtTolerance(operand.tolerance, unit) : null
                return (
                  <div key={`${operand.label}-${index}`} className="flex flex-col gap-0.5 text-xs">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-muted-foreground">{operand.label}</span>
                      {operand.value != null && (
                        <span className="font-mono text-foreground">
                          {formatInput(operand.value)}
                          {unit && ` ${unit}`}
                        </span>
                      )}
                      {band && <span className="text-muted-foreground">{band}</span>}
                      {operand.provenance && (
                        <span
                          className="rounded bg-muted px-1 py-px text-[0.9em] text-muted-foreground"
                          title={provenanceTitle(operand.provenance, t)}
                        >
                          {provenanceLabel(operand.provenance, t)}
                        </span>
                      )}
                    </div>
                    {operand.source && (
                      <span className="text-[0.92em] leading-snug text-muted-foreground">{operand.source}</span>
                    )}
                  </div>
                )
              })}
              <p className="mt-0.5 max-w-prose text-[0.92em] leading-relaxed text-muted-foreground">
                {t('cards.calculation.computedNote')}
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </SchematicCard>
  )
}
