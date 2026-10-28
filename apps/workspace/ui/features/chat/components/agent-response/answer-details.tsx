import { type ReactNode, memo, useState } from 'react'

import { cn } from '@/lib/utils'
import { ChevronDown } from 'lucide-react'
import { useLocale, useTranslations } from '@/i18n'
import { AnswerCost } from '../AnswerCost'
import { chatCopy } from '@/i18n/namespaces/chat'
import { formatTime } from '@/shared/utils/format-time'
import { formatDurationElapsed } from '@/lib/format'
import type { CitationSource } from '../../types'
import type { AnswerConfidenceCappedReason } from '@/lib/conversations/message-provenance'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { SkillsUsedDisclosure } from '@/features/skills/components/SkillsUsedDisclosure'
import { ConfidenceChip, type AnswerConfidence } from '../ConfidenceChip'
import type { ConfidenceCheck } from '@/lib/conversations/confidence-check'
import { CitationsRemovedNote, ResearchTruncatedNote, AnswerDegradedNote } from './answer-notes'
import { ReadSourcesSection } from './read-sources'

/**
 * The single disclosure in the answer footer.
 *
 * The footer keeps verdict, body, the "Belegt durch" sources row, the copy
 * actions, the memory chip (`beside` the trigger) and the feedback thumbs
 * visible; everything else the turn carries
 * — confidence, the skills that shaped the answer, the
 * verification notes and the timestamp — lives behind ONE muted text-xs
 * trigger line. When the turn carries something the reader must not miss —
 * a cut-off, a salvaged run, stripped citations, low confidence — the trigger
 * carries a warning dot, because a warning behind an unmarked trigger is a
 * warning nobody read. It does not open itself: the warnings land at the
 * settle, and the disclosure opening then moved the footer under a reader
 * who had just reached the end. `SkillsUsedDisclosure` is MOVED here, not duplicated: it
 * renders null on a turn that activated nothing, like every other item
 * inside. Feedback stays out on purpose: rating the answer must not cost a
 * click first.
 */
export const AnswerDetails = memo(function AnswerDetails({
  hasConfidence,
  answerConfidence,
  answerConfidenceCappedReason,
  answerConfidenceReason,
  confidenceCheck,
  answerConfidenceVersion,
  skillsActivated,
  skillsHidden,
  showReasoning,
  researchTruncated,
  truncationReason,
  degradedReasons,
  citationsRemoved,
  readSources,
  hasAnswerSources,
  timestamp,
  answerDurationMs,
  conversationId,
  messageId,
  before,
  beside,
  after,
}: {
  hasConfidence: boolean
  answerConfidence?: AnswerConfidence
  answerConfidenceCappedReason?: AnswerConfidenceCappedReason
  answerConfidenceReason?: string
  confidenceCheck?: ConfidenceCheck
  answerConfidenceVersion?: 1 | 2
  skillsActivated?: string[]
  skillsHidden?: string[]
  showReasoning?: boolean
  researchTruncated?: true
  truncationReason?: string
  degradedReasons?: string[]
  citationsRemoved?: { count: number; reasons: string[] }
  readSources?: CitationSource[]
  hasAnswerSources: boolean
  timestamp?: Date | string
  answerDurationMs?: number
  /** Both needed for the answer's cost line; without either it is omitted. */
  conversationId?: string | null
  messageId?: string
  /** Set on the trigger's own line: the footer's copy actions before it, feedback after. */
  before?: ReactNode
  /**
   * Right after the trigger, before the spacer: what the turn wants SEEN
   * without opening anything (the memory chip). After the trigger so that a
   * chip arriving late moves nothing the reader already found.
   */
  beside?: ReactNode
  after?: ReactNode
}) {
  const t = useTranslations(chatCopy)
  // Without the locale `formatTime` uses the RUNTIME default, so a German user on
  // an en-US browser got "03:35 PM" beside cards that all say "15:35".
  const { locale } = useLocale()
  const [open, setOpen] = useState(false)
  // Something the reader must not miss: a cut-off, a salvaged run, stripped
  // citations, low confidence. These arrive with the terminal frame, after the
  // answer settled, and used to OPEN the disclosure from an effect: 100-400px
  // snapping in under a reader who had just reached the end. Now the trigger
  // carries a warning dot instead, positioned over the gap beside it so it
  // takes no width and moves nothing, and fading in only when it arrives in
  // front of the reader. The details open when the reader asks.
  const needsAttention = Boolean(
    researchTruncated ||
    degradedReasons?.length ||
    citationsRemoved?.count ||
    answerConfidence === 'low'
  )
  const [attentionAtMount] = useState(needsAttention)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex w-full flex-col">
      {/* One line: copy, the trigger, and feedback at the far end. The
          Collapsible is full-width so its content can open below; with the
          trigger alone inside it, it took a line of its own under the rest. */}
      <div className="flex min-h-6 flex-wrap items-center gap-2">
        {before}
        <CollapsibleTrigger
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 touch-target duration-quick flex items-center gap-1.5 self-start rounded-md text-xs leading-relaxed transition-colors ease-out focus-visible:ring-2 focus-visible:outline-none pointer-coarse:self-center"
          aria-label={t(
            needsAttention ? 'answerDetails.triggerAriaAttention' : 'answerDetails.triggerAria'
          )}
          data-testid="answer-details-trigger"
        >
          <span>{t('answerDetails.trigger')}</span>
          <span className="relative inline-flex">
            <ChevronDown
              className={`duration-quick size-3 shrink-0 transition-transform ease-out motion-reduce:transition-none${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
            {needsAttention && (
              <span
                aria-hidden="true"
                data-testid="answer-details-attention"
                className={cn(
                  'text-feedback-warning absolute top-0 -right-2 size-1.5 rounded-full bg-current',
                  !attentionAtMount &&
                    'animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none'
                )}
              />
            )}
          </span>
        </CollapsibleTrigger>
        {beside}
        {after ? (
          <>
            <span className="flex-1" aria-hidden="true" />
            {after}
          </>
        ) : null}
      </div>
      <CollapsibleContent className="mt-1.5">
        <div className="flex flex-col gap-2">
          {hasConfidence && (
            <ConfidenceChip
              confidence={answerConfidence}
              cappedReason={answerConfidenceCappedReason}
              reason={answerConfidenceReason}
              check={confidenceCheck}
              version={answerConfidenceVersion}
            />
          )}
          <SkillsUsedDisclosure
            skillsActivated={skillsActivated}
            hiddenSkills={skillsHidden}
            showReasoning={showReasoning}
          />
          <ResearchTruncatedNote
            researchTruncated={researchTruncated}
            truncationReason={truncationReason}
            hasSources={hasAnswerSources}
          />
          <AnswerDegradedNote degradedReasons={degradedReasons} />
          <CitationsRemovedNote citationsRemoved={citationsRemoved} />
          <ReadSourcesSection readSources={readSources} />
          {(Boolean(timestamp) || Boolean(answerDurationMs)) && (
            <span className="text-subtle text-xs" data-testid="answer-time">
              {timestamp && formatTime(timestamp, locale)}
              {timestamp && answerDurationMs ? ' · ' : null}
              {answerDurationMs
                ? t('answerDetails.duration', {
                    duration: formatDurationElapsed(answerDurationMs / 1000, locale),
                  })
                : null}
            </span>
          )}
          {conversationId && messageId ? (
            <AnswerCost conversationId={conversationId} messageId={messageId} />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})
