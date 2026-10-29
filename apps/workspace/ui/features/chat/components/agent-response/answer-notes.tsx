import { type FC } from 'react'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { ANSWER_DEGRADED_REASONS, TRUNCATION_REASONS } from '@/lib/conversations/message-provenance'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * The verification's own vocabulary for dropping a citation
 * (`citations/`, the backend package). Listed here because THIS is the file
 * that owns the words for them — see {@link localizeToken}.
 */
const CITATION_REMOVAL_REASONS = [
  'url_not_in_registry',
  'citation_key_not_in_registry',
  'unverifiable',
  'duplicate',
  'ungrounded',
  'quote_unverified',
] as const

/**
 * One stable backend token, in the reader's language — or nothing.
 *
 * The backend states these as tokens ON PURPOSE: it has no locale, and a
 * sentence composed in the agent tier would arrive in whichever language that
 * turn happened to think in. So the frontend owns the words, which makes the
 * unknown-token case the one that matters. It is not hypothetical — a token is
 * added on the producer's release train, not ours, and it also arrives from a
 * jsonb row written by a build that is not this one.
 *
 * The allow-list is checked BEFORE `t()` rather than trusting the dictionary to
 * miss: `createTranslator` falls back to the key itself, so an unmapped token
 * would not render nothing, it would render
 * `answerSources.truncationReason.tool_budget` under an answer about building
 * law. Silence is the honest rendering of "the system said something this build
 * cannot put into words" — the FACT (the run was cut off, N citations were
 * dropped) is carried by the line the token only qualifies, and that line still
 * renders.
 */
function localizeToken(
  t: Translator,
  group: string,
  token: string,
  known: readonly string[]
): string | null {
  return known.includes(token) ? t(`${group}.${token}`) : null
}

/**
 * The same, for a LIST of tokens: localized, de-duplicated, order preserved.
 * Duplicates are dropped by the rendered SENTENCE rather than by the token, so
 * two tokens that this build words identically still produce one line.
 */
function localizeTokens(
  t: Translator,
  group: string,
  tokens: string[] | undefined,
  known: readonly string[]
): string[] {
  const lines: string[] = []
  for (const token of tokens ?? []) {
    const line = typeof token === 'string' ? localizeToken(t, group, token, known) : null
    if (line && !lines.includes(line)) lines.push(line)
  }
  return lines
}

/**
 * Muted note under the "Belegt durch" row: citation verification removed one or
 * more citations from this answer as unverifiable (WP-A `citations_removed`).
 * The de-duplicated reasons hang off a tooltip so the row stays quiet by
 * default. Renders nothing when nothing was removed.
 */
export const CitationsRemovedNote: FC<{
  citationsRemoved?: { count: number; reasons: string[] }
}> = ({ citationsRemoved }) => {
  const t = useTranslations(chatCopy)
  if (!citationsRemoved || citationsRemoved.count <= 0) return null

  const label = t('answerSources.citationsRemoved', { count: citationsRemoved.count })
  // Localized, not passed through. These are verification TOKENS
  // (`url_not_in_registry`), and the tooltip used to print them verbatim — which
  // nobody outside this repository can read. A token with no sentence here is
  // left out; the count above is the fact and it is unaffected.
  const reasons = localizeTokens(
    t,
    'answerSources.citationsRemovedReason',
    citationsRemoved.reasons,
    CITATION_REMOVAL_REASONS
  )

  const text = (
    <span className="text-muted-foreground text-xs leading-relaxed" role="note">
      {label}
    </span>
  )

  if (reasons.length === 0) {
    return <div className="mt-1.5">{text}</div>
  }

  return (
    <div className="mt-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="focus-visible:ring-ring/60 cursor-help rounded-control text-left focus-visible:ring-2 focus-visible:outline-none"
            aria-label={label}
          >
            <span className="text-muted-foreground text-xs leading-relaxed underline decoration-dotted underline-offset-2">
              {label}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {/* `text-current`: the tooltip paints its own foreground, and the
              eyebrow's muted ink would drop below AA on it. */}
          <SectionLabel className="mb-1 block text-current">
            {t('answerSources.citationsRemovedReasonsLabel')}
          </SectionLabel>
          <ul className="list-disc space-y-0.5 pl-4">
            {reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * The search ran and found nothing, and the answer is shown anyway (ADR-0125).
 * It used to be replaced by a canned „nothing retrieved" message; now the
 * reader gets the answer and this note, so they can see it rests on the
 * model's own knowledge and nothing it could cite. Above the sources row,
 * not in the details: it changes how the whole answer reads.
 */
export const LookupFoundNothingNote: FC<{ show: boolean }> = ({ show }) => {
  const t = useTranslations(chatCopy)
  if (!show) return null
  return (
    <div className="mt-1.5" data-testid="lookup-found-nothing">
      <span className="text-feedback-warning text-xs leading-relaxed" role="note">
        {t('answerSources.lookupFoundNothing')}
      </span>
    </div>
  )
}

export const ResearchTruncatedNote: FC<{
  researchTruncated?: true
  truncationReason?: string
  hasSources: boolean
}> = ({ researchTruncated, truncationReason, hasSources }) => {
  const t = useTranslations(chatCopy)
  if (!researchTruncated) return null
  const sentence = t(
    hasSources ? 'answerSources.researchTruncated' : 'answerSources.researchTruncatedWithoutSources'
  )
  // The cause rides the same line as a parenthetical rather than claiming one of
  // its own: "it ran out of time" is not a second statement, it is the first one
  // finished. Absent (or unknown) leaves the sentence exactly as it was before
  // this field existed, which is what every turn before today's backend has.
  const cause = truncationReason
    ? localizeToken(t, 'answerSources.truncationReason', truncationReason, TRUNCATION_REASONS)
    : null
  return (
    <div className="mt-1.5">
      <span className="text-muted-foreground text-xs leading-relaxed" role="note">
        {cause ? `${sentence} (${cause})` : sentence}
      </span>
    </div>
  )
}

/**
 * What the cutoff COST — one muted line per degradation, under the truncation
 * line and in the same register.
 *
 * Separate lines rather than one joined sentence because the two known
 * degradations ask for different things: "no report was filed" tells the reader
 * this thread is the only copy, "nothing survived verification" tells them to
 * check the figures before they use them. Joining them would make one of the two
 * a subordinate clause of the other.
 *
 * Still `role="note"`, still no icon, tint or border. A salvaged answer can be
 * perfectly well-grounded in what it did reach, and this must not turn a good
 * one into an alarm — but it must also never be silent about the way the answer
 * is weaker, which is precisely what it was before this rendered at all.
 */
export const AnswerDegradedNote: FC<{ degradedReasons?: string[] }> = ({ degradedReasons }) => {
  const t = useTranslations(chatCopy)
  const lines = localizeTokens(
    t,
    'answerSources.degradedReason',
    degradedReasons,
    ANSWER_DEGRADED_REASONS
  )
  // An empty list is not a claim: a turn that degraded in none of the known ways
  // — and one whose every token this build cannot word — says nothing here.
  if (lines.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-col gap-0.5">
      {lines.map((line) => (
        <span key={line} className="text-muted-foreground text-xs leading-relaxed" role="note">
          {line}
        </span>
      ))}
    </div>
  )
}
