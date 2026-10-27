'use client'

import { type FC } from 'react'
import { Gauge } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import {
  claimEvidenceCount,
  claimMix,
  claimWarning,
  type ClaimMix,
  type ClaimStamp,
} from '@/lib/conversations/message-claim-stamps'
import type {
  AnswerConfidenceCappedReason,
  AnswerConfidenceVersion,
} from '@/lib/conversations/message-provenance'

/** The three self-assessment levels the model can report. */
export type AnswerConfidence = 'low' | 'medium' | 'high'

/**
 * Wire value → dictionary key. A lookup rather than a ternary chain so adding a
 * cause to {@link AnswerConfidenceCappedReason} fails to compile here until its
 * copy exists, instead of silently rendering no explanation for the cap.
 */
const CAPPED_REASON_KEYS: Record<AnswerConfidenceCappedReason, string> = {
  ungrounded: 'ungrounded',
  quote_unverified: 'quoteUnverified',
  normative_claim_uncited: 'normativeClaimUncited',
  measurement_only: 'measurementOnly',
  citation_fallback: 'citationFallback',
}

/** The mix line's parts, in the order they are read: what holds first, what does not last. */
const MIX_PARTS: readonly (keyof ClaimMix)[] = [
  'supported',
  'observed',
  'reasoning',
  'modelKnowledge',
  'normativeUncited',
  'dropped',
]

interface ConfidenceChipProps {
  /** The model's guarded self-assessment; undefined/null renders nothing. */
  confidence: AnswerConfidence | null | undefined
  /**
   * Why the self-assessment was capped (WP-A transparency extra), appended as an
   * extra sentence to the tooltip so the cap is explained rather than silent
   * (PB-9). See {@link AnswerConfidenceCappedReason} for the causes it can
   * carry; the type is the list, so no count is restated here to go stale.
   */
  cappedReason?: AnswerConfidenceCappedReason
  /**
   * The model's own one-clause justification for its level
   * (`[CONFIDENCE:level | reason]`), shown verbatim in the tooltip so the
   * reader can see WHY the level was chosen. Absent on older turns and when
   * the marker carried no reason.
   */
  reason?: string
  /**
   * Which rule computed the level. 2 reads the per-sentence stamps: held to the
   * weakest one (ADR-0125), or, when the stamps carry `support`, counted
   * (rule 3, ADR-0139), and the chip then leads with the count of backed
   * claims instead of a level. Absent on an answer stored before rule 2, which
   * keeps the copy of the answer-level floors it was computed with.
   */
  version?: AnswerConfidenceVersion
  /** Where each sentence comes from; read under rules 2 and 3. */
  claimStamps?: readonly ClaimStamp[]
}

/**
 * "Confidence: high" — the assistant's OWN, guarded self-assessment of how well
 * an answer is grounded. Honest, deliberately subtle, and clearly framed as a
 * self-assessment that can be wrong (tooltip). Renders nothing when absent, so
 * historical messages, deep-research turns, and error turns show no chip. Low
 * uses the warning tone (sparingly) to nudge caution; medium/high stay muted so
 * a confident answer never shouts.
 *
 * The tooltip explains the chip in full: what the level means, the model's own
 * reason (when given), the self-assessment caveat, any deterministic cap, and
 * under rules 2 and 3 the mix of what the sentences rest on
 * („5 Aussagen belegt · 1 Einschätzung · 1 Rechtsaussage ohne Beleg").
 *
 * Under rule 3 (ADR-0139) the chip itself leads with the measured count
 * („12 von 14 Aussagen belegt"), as the field does: what the answer rests on,
 * not how sure the model says it is. It turns to the warning tone only with a
 * named reason, read off the stamps first, and names it beside the count
 * („· Rechtsaussage ohne Beleg"); the level and the model's own assessment
 * move to the tooltip.
 */
export const ConfidenceChip: FC<ConfidenceChipProps> = ({
  confidence,
  cappedReason,
  reason,
  version,
  claimStamps,
}) => {
  const t = useTranslations('chat')

  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') {
    return null
  }

  // Rule 3 is version 2 with `support` on its stamps (the wire keeps 2 for open tabs).
  const count = version === 2 && claimStamps ? claimEvidenceCount(claimStamps) : null
  const byClaim = version === 2
  // Rule 3 with a count leads with what the answer rests on; every other
  // answer keeps the copy of the rule it was computed under.
  const copy = count ? 'confidence.byShare' : byClaim ? 'confidence.byClaim' : 'confidence'
  const levelLabel = t(`confidence.levels.${confidence}`)
  const capKey = cappedReason ? CAPPED_REASON_KEYS[cappedReason] : undefined
  // Under rule 3 the warning is read off the stamps first (an uncited statement
  // about the law, a pointer that did not hold), so it does not depend on the
  // model having reported more than the evidence allows; a cap on the
  // self-report that the stamps do not explain (an unconfirmed quote) comes next.
  const warnKey = count ? ((claimStamps && claimWarning(claimStamps)) ?? capKey) : capKey
  const label = count
    ? [
        t('confidence.byShare.label', { backed: count.backed, claims: count.claims }),
        warnKey ? t(`confidence.byShare.capLabels.${warnKey}`) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : t('confidence.label', { level: levelLabel })
  // Under rule 3 the warning tone is a named reason, never the model's own
  // „low" on its own: the chip says what the answer rests on, and warns only
  // with a reason (ADR-0139).
  const variant = (count ? warnKey !== undefined : confidence === 'low') ? 'warning' : 'muted'
  // When the confidence was capped, explain WHY in the tooltip (PB-9) instead of
  // leaving the downgrade silent. Fail-open: an absent/unknown reason keeps the
  // generic tooltip. Rules 2 and 3 have their own sentences: the cap there is
  // about the answer's claims.
  const cappedReasonText = warnKey ? t(`${copy}.cappedReasons.${warnKey}`) : undefined
  // Trim only to DETECT an empty/whitespace-only reason; the reason itself is
  // rendered verbatim, as the wire contract promises.
  const displayReason = reason?.trim() ? reason : undefined
  const mix = byClaim && claimStamps && claimStamps.length > 0 ? claimMix(claimStamps) : null
  const mixText = mix
    ? MIX_PARTS.filter((part) => mix[part] > 0)
        .map((part) => t(`confidence.byClaim.mix.${part}`, { count: mix[part] }))
        .join(' · ')
    : ''

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Chip
          asChild
          variant={variant}
          size="sm"
          interactive
          aria-label={
            count
              ? t('confidence.byShare.ariaLabel', {
                  backed: count.backed,
                  claims: count.claims,
                  level: levelLabel,
                })
              : t('confidence.ariaLabel', { level: levelLabel })
          }
        >
          <button type="button">
            <Gauge aria-hidden="true" />
            {label}
          </button>
        </Chip>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <span className="block">{t(`${copy}.levelMeanings.${confidence}`)}</span>
        {mixText ? (
          <span className="mt-1 block" data-testid="confidence-claim-mix">
            {mixText}
          </span>
        ) : null}
        {displayReason ? (
          <span className="mt-1 block">
            <span className="font-medium">
              {t(cappedReason ? 'confidence.reasonLabelBeforeCap' : 'confidence.reasonLabel')}:
            </span>{' '}
            {displayReason}
          </span>
        ) : null}
        <span className="mt-1 block">{t(`${copy}.tooltip`)}</span>
        {count ? (
          <span className="mt-1 block">
            {t('confidence.byShare.selfAssessment', { level: levelLabel })}
          </span>
        ) : null}
        {cappedReasonText ? <span className="mt-1 block">{cappedReasonText}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}
