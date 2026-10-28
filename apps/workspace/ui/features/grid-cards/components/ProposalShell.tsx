'use client'

import { useLayoutEffect, useRef, type ReactNode, type Ref } from 'react'
import { useIsPresent, type Transition } from 'motion/react'
import { CircleCheck, CircleMinus, type LucideIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import {
  AnimatePresence,
  motion,
  motionQuick,
  motionQuickExit,
  useMotionToken,
} from '@/components/motion'
import { useHeightGlide } from '@/components/motion/height-glide'
import { cn } from '@/lib/utils'
import { CARD_SHELL } from './card-chrome'

/** A proposal card's lifecycle state. */
type ProposalTone = 'pending' | 'accepted' | 'dismissed'

/**
 * An outcome's glyph, beside the receipt's words. `pending` has none: the
 * question is the state.
 *
 * Lifecycle is its own axis (`answer-card-charter.md` §A3), and it used to be an
 * accent edge whose colour tracked the state. Side stripes are discouraged
 * (design-language.md, "Emphasis without a stripe"), and an edge said the
 * outcome in colour alone; the glyph says it in shape, the receipt in words,
 * and the verdict colour only reinforces both (WCAG 1.4.1).
 */
const OUTCOME_GLYPH: Record<ProposalTone, LucideIcon | null> = {
  pending: null,
  accepted: CircleCheck,
  dismissed: CircleMinus,
}

const OUTCOME_INK: Record<ProposalTone, string> = {
  pending: '',
  accepted: 'text-success',
  dismissed: 'text-muted-foreground',
}

/** A question breathes more than its one-line receipt. */
const TONE_GAP: Record<ProposalTone, string> = {
  pending: 'gap-3',
  accepted: 'gap-2',
  dismissed: 'gap-2',
}

/**
 * One state's content. While it leaves it is out of reach: unclickable and
 * hidden from assistive tech, so a second press cannot land on a question
 * that has already been answered, and the receipt is the only thing read.
 */
function ProposalBody({
  ref,
  tone,
  enter,
  exit,
  children,
}: {
  ref: Ref<HTMLDivElement>
  tone: ProposalTone
  enter: Transition
  exit: Transition
  children: ReactNode
}) {
  const present = useIsPresent()
  const Glyph = OUTCOME_GLYPH[tone]
  return (
    <motion.div
      ref={ref}
      tabIndex={-1}
      data-proposal-body={tone}
      aria-hidden={present ? undefined : true}
      className={cn('flex flex-col outline-none', TONE_GAP[tone], !present && 'pointer-events-none')}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: enter }}
      exit={{ opacity: 0, transition: exit }}
    >
      {Glyph ? (
        <div className="flex items-start gap-2">
          <Glyph data-outcome={tone} className={cn('mt-0.5 size-4 shrink-0', OUTCOME_INK[tone])} aria-hidden />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      ) : (
        children
      )}
    </motion.div>
  )
}

/**
 * The shared shell for user-confirmed proposal cards (`project_profile_patch`,
 * `memory_proposal`, `file_operation_proposal`): a card on the quiet card
 * ground whose receipt carries the outcome's glyph — a green check once
 * accepted, a muted minus once dismissed (see OUTCOME_GLYPH above). The cards
 * used to hand-roll this identical `motion.div` + `Card p-5 shadow-xs` chrome
 * and state machine; this owns it once so they can't drift.
 *
 * THE ANSWER IS ONE CARD CHANGING, not one card replaced by another. A card
 * returns `<ProposalShell tone=…>` from each branch, so React keeps this one
 * instance across the decision, and the shell turns the swap into motion:
 *
 *  - the question cross-fades into its receipt (`popLayout`: the outgoing body
 *    leaves the flow at once and fades out over the incoming one);
 *  - the card glides from the question's height to the receipt's
 *    (`useHeightGlide`), so the answer below is drawn up, not yanked — the
 *    reader pressed a button, and the 120px under it used to vanish in the
 *    frame they pressed it.
 *
 * And the keyboard is not dropped. The control the reader pressed leaves with
 * the question, and a focused node that leaves the document hands focus to
 * `<body>`, so the next Tab started from the top of the page. When focus was
 * inside the card, it moves to the receipt (`tabIndex={-1}`, no scroll), which
 * is also what makes a screen reader read the outcome.
 */
export function ProposalShell({
  tone,
  className,
  children,
}: {
  tone: ProposalTone
  className?: string
  children: ReactNode
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const previousTone = useRef(tone)
  const enter = useMotionToken(motionQuick)
  const exit = useMotionToken(motionQuickExit)
  useHeightGlide(frameRef, tone)

  // The swap's commit: the outgoing body is still in the document (exiting),
  // so the focus it holds is still readable here, and the incoming body's ref
  // is already attached.
  useLayoutEffect(() => {
    if (previousTone.current === tone) return
    previousTone.current = tone
    const active = document.activeElement
    if (active && active !== document.body && frameRef.current?.contains(active)) {
      bodyRef.current?.focus({ preventScroll: true })
    }
  }, [tone])

  return (
    // No entrance of its own. A card the reader watches arrive is faded in by
    // its slot (`CardSlot`) and a new turn by its thread row; a root fade here
    // replayed on every remount (a restored thread, a re-render by position)
    // and doubled the slot's fade on a live one.
    <Card
      className={cn(CARD_SHELL, 'p-5', className)}
    >
      {/* The frame the height glides on. `relative` is for `popLayout`,
          which positions the outgoing body absolutely against it. */}
      <div ref={frameRef} className="relative">
        <AnimatePresence mode="popLayout" initial={false}>
          <ProposalBody key={tone} ref={bodyRef} tone={tone} enter={enter} exit={exit}>
            {children}
          </ProposalBody>
        </AnimatePresence>
      </div>
    </Card>
  )
}
