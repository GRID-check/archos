import type { AgentResponseProps } from './agent-response-props'
import { type FC } from 'react'

import { motion, useIconSwapTransition } from '@/components/motion'
import { Check } from 'lucide-react'

import type { AnswerKind } from '@/lib/conversations/message-answer-meta'

/**
 * The mark on the role tab. A check says the answer is complete, so it is
 * held back while the answer arrives (and after Stop, which leaves it
 * incomplete): a quiet dot stands in its place at the same size, and at the
 * settle the check lands on `iconSwapTransition` (scale on `springSnap`,
 * opacity on a tween), the turn's one small moment of arrival, and simply
 * appears under reduced motion. A restored answer shows its check at once.
 */
export const RoleTabMark: FC<{ complete: boolean; arrived: boolean }> = ({ complete, arrived }) => {
  const swap = useIconSwapTransition()
  return (
    <span className="inline-flex size-2.5 items-center justify-center" aria-hidden="true">
      {complete ? (
        <motion.span
          className="inline-flex"
          initial={arrived ? { opacity: 0, scale: 0.6 } : false}
          animate={{ opacity: 1, scale: 1, transition: swap.enter }}
        >
          <Check className="size-2.5" strokeWidth={2.6} />
        </motion.span>
      ) : (
        <span
          className="size-1 rounded-full bg-current opacity-60"
          data-testid="role-tab-pending"
        />
      )}
    </span>
  )
}

/** Role-tab label for the default answer card. Envelope `kind` wins. */
export function answerRoleTab(
  kind: AnswerKind | undefined,
  routingDecision: AgentResponseProps['routingDecision'],
  hasVerdict: boolean
): 'note' | 'answer' | 'result' {
  if (kind === 'direct' || kind === 'handoff') return 'note'
  if (kind === 'walkthrough' || kind === 'work') return 'answer'
  if (kind === 'ruling' || (!kind && hasVerdict)) return 'result'
  if (routingDecision === 'meta') return 'note'
  return 'result'
}

/**
 * The caret at the tail of a still-streaming answer (C6), placed after the
 * last word by the renderer (`streaming-caret.tsx`).
 *
 * It takes no room: a zero-width box at the baseline, the bar and the veil
 * drawn out of it. A caret with a width pushed the last word to the next line
 * when it just fitted, and pulled it back when the caret moved on.
 *
 * Solid while words advance and breathing only while the reveal stands still
 * (`idle`, from `usePacedText`), as an editor's caret does: a caret pulsing
 * under arriving words read as a blink, and the pause is what a breath is
 * for. It fades out while the finish reveals the last words (`fading`), so by
 * the time the answer settles and it is removed there is nothing left to
 * disappear. The fade is on the wrapper and the breath on the bar: two
 * animations of one property on one element fight.
 *
 * `veil`: the newest words come out of a short gradient trailing the caret,
 * drawn in the card's colour, so each word the reveal adds starts faint and
 * darkens as the next ones push it out, like ink settling. Eased stops rather
 * than a straight ramp, so the faint end does not read as an edge. It moves
 * with the caret and animates nothing, so it costs no more than the caret
 * does. A fade per word (a span per word, each with its own entrance) cost a
 * 4x throttled phone 10 fps and 200 ms of main thread a second on a
 * prose-heavy answer (docs/design/streaming-chat-answer.md). Only on the card,
 * whose colour it is drawn in.
 */
export const StreamingCaret: FC<{ fading?: boolean; veil?: boolean; idle?: boolean }> = ({
  fading = false,
  veil = false,
  idle = false,
}) => (
  <span
    aria-hidden="true"
    data-testid="streaming-caret"
    data-idle={idle ? 'true' : undefined}
    className={`group/caret duration-base relative inline-block h-0 w-0 transition-opacity ease-out ${fading ? 'opacity-0' : 'opacity-100'}`}
  >
    {veil && (
      // Hidden after markup with a ground of its own (a code span, a citation
      // pill: `data-caret-after`), which the card's colour would paint over,
      // and wherever the reader asked for contrast or the system's colours.
      <span className="pointer-events-none absolute right-0 -bottom-[0.3em] h-[1.4em] w-[2.5em] bg-[linear-gradient(to_right,transparent,color-mix(in_oklab,var(--card)_30%,transparent)_45%,var(--card))] in-data-[caret-after=markup]:hidden contrast-more:hidden forced-colors:hidden" />
    )}
    <span className="bg-foreground/70 group-data-[idle=true]/caret:animate-caret-breathe absolute -bottom-[0.2em] left-px h-[1.1em] w-[2px] rounded-full motion-reduce:animate-none forced-colors:bg-[CanvasText]" />
  </span>
)
