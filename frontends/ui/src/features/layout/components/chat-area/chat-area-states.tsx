import { type FC } from 'react'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useChatStore } from '@/features/chat/store'
import { useElapsedSeconds, formatElapsed } from '@/features/chat'
import { cn } from '@/lib/utils'
import { useAuth } from '@/adapters/auth'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { WELCOME_OFFSET_FALLBACK } from '../../hooks/use-composer-metrics'
import { TOOLBAR_CLEAR_PADDING } from '../../lib/toolbar-clearance'

/**
 * "New" separator marking where the reader left off in a shared thread (spec
 * CC-19). A rule with a centred label rather than a coloured band: it has to be
 * findable when scrolling a long thread without competing with the messages, and
 * it must not read as an error state.
 *
 * Deliberately the house eyebrow (hairline border + uppercase muted label), not
 * full-strength ink: this is a *reading-position* marker, and at ink weight it was
 * the loudest thing in the column — out-shouting the agent's answer, which is the
 * one element that must stay dominant. The two full-width rules are what make it
 * findable; the label does not have to shout to be one.
 */
export const UnreadDivider: FC<{ label: string }> = ({ label }) => (
  <div
    className="flex items-center gap-3"
    role="separator"
    aria-label={label}
    data-testid="unread-divider"
  >
    <span className="bg-border h-px flex-1" aria-hidden="true" />
    <SectionLabel>{label}</SectionLabel>
    <span className="bg-border h-px flex-1" aria-hidden="true" />
  </div>
)

/**
 * "Piloti is answering <name>'s question" — the observer's view of a turn that is
 * not theirs (spec CC-13).
 *
 * This is now the FALLBACK rather than the whole story: with the frame relay in
 * place (ADR-0039) an observer watches the answer being written, and `SpectatedTurn`
 * renders it. The banner is what remains when the frames cannot reach them — no
 * shared cache tier, a dropped stream, or simply the first moments before the first
 * token. It is not a lesser version of the feature: what matters most is that the
 * wait is explained, because without it a second participant sees a thread where
 * nothing is happening and a composer that will not take their question, which reads
 * as a broken product rather than a busy one.
 *
 * It says *the assistant is working*, not *somebody is typing*: the Piloti glyph
 * plus the shimmering label — this app's own vocabulary for a turn in progress
 * (`TypingIndicator`, the Herleitung spine) — rather than the three bouncing dots
 * of a messenger, which describe a human at a keyboard and would frame Piloti as
 * one more participant in a group chat. A status strip at the house radius, not a
 * chat bubble.
 */
export const TurnInFlightBanner: FC<{ label: string }> = ({ label }) => (
  <div
    className="bg-card flex min-h-9 w-fit items-center gap-2 rounded-lg border px-3.5 py-2 shadow-xs"
    role="status"
    data-testid="turn-in-flight"
  >
    <ShimmerText className="text-xs font-medium">{label}</ShimmerText>
  </div>
)

/**
 * Latency-gap typing indicator (three pulsing dots) shown under an answered
 * HITL prompt until the turn resumes. Left-aligned to match assistant bubbles.
 */
export const TypingIndicator: FC = () => {
  const t = useTranslations('research')
  const label = t('chatArea.status.thinking')
  // Mounted when the reader answers the prompt, so counting from mount is the
  // true time since that answer.
  const elapsed = useElapsedSeconds(true)
  return (
    <div
      className="animate-in fade-in-0 bg-muted duration-base flex min-h-9 w-fit items-center gap-2 rounded-2xl px-3.5 py-2.5 ease-out motion-reduce:animate-none"
      role="status"
      aria-label={label}
    >
      <span className="flex items-center gap-1 motion-reduce:hidden" aria-hidden="true">
        {/* CSS, not a JS loop: transform and opacity run on the compositor,
            so the dots cost the main thread nothing while a phone waits. */}
        <span className="animate-typing-dot bg-muted-foreground/70 size-1.5 rounded-full" />
        <span className="animate-typing-dot bg-muted-foreground/70 size-1.5 rounded-full" />
        <span className="animate-typing-dot bg-muted-foreground/70 size-1.5 rounded-full" />
      </span>
      <span
        className="text-muted-foreground hidden text-xs motion-reduce:inline"
        aria-hidden="true"
      >
        …
      </span>
      {/* Always word the wait (shimmering), and surface elapsed seconds once
          past a couple of seconds so a slow first token never feels stalled. */}
      <ShimmerText className="text-xs font-medium">{label}</ShimmerText>
      {/* aria-hidden: inside a status region, a figure that changes every
          second was re-announced every second. */}
      {elapsed > 2 && (
        <span className="text-muted-foreground text-xs tabular-nums" aria-hidden="true">
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  )
}

/**
 * Hydration skeleton (C5): a few grey bubbles sized to the message area, shown
 * only while the persisted chat store rehydrates so a returning user never sees
 * a WelcomeState flash before their thread loads in.
 */
export const MessageListSkeleton: FC = () => {
  const t = useTranslations('research')
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 sm:px-6',
        TOOLBAR_CLEAR_PADDING
      )}
      style={{ paddingBottom: 'calc(var(--composer-h, 11rem) + 1.5rem)' }}
      role="status"
      aria-label={t('chatArea.loading')}
      aria-busy="true"
    >
      {/* user bubble (right) */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-1/2 rounded-lg" />
      </div>
      {/* assistant answer card (left): a tab-width bar and a footer line around
          the body, mirroring the answer card's shape rather than a bare slab */}
      <div className="flex justify-start">
        <div className="flex w-4/5 flex-col gap-2">
          <Skeleton className="h-4 w-20 rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-3 w-1/3 rounded-lg" />
        </div>
      </div>
      {/* user bubble (right) */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-1/3 rounded-lg" />
      </div>
    </div>
  )
}

/**
 * Welcome state shown when no messages exist.
 *
 * Signed in: a time-of-day greeting (with the user's first name when known),
 * hero-sized per the click dummy, and nothing else unless the thread is about a
 * named file. It used to carry a subtitle and a row of example questions too;
 * both were addressed to a first-timer and were paid for by every user on every
 * new thread forever. What replaces them is the composer itself, lifted off the
 * floor to sit with the greeting as one group in the middle of the screen (see
 * `useComposerMetrics`) — an empty canvas that offers the one thing there is to
 * do, rather than explaining it.
 *
 * Signed out: a compact sign-in prompt. Bottom padding in both keeps the
 * centered content clear of the floating composer, and is what the lift is
 * calculated against — do not change one without the other.
 */
interface WelcomeStateProps {
  isAuthenticated?: boolean
  onSignIn?: () => void
  /**
   * The canvas belongs to a project, so the one sentence about what Piloti can
   * do with it is true here. Outside a project there is nowhere for a draft to
   * be filed, and the sentence would be an offer the surface cannot keep.
   */
  inProject?: boolean
}

/** Time-of-day bucket for the greeting (morning / afternoon / evening). */
const greetingKeyForHour = (hour: number): 'morning' | 'afternoon' | 'evening' => {
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

export const WelcomeState: FC<WelcomeStateProps> = ({
  isAuthenticated = false,
  onSignIn,
  inProject = false,
}) => {
  const t = useTranslations('research')
  const tChat = useTranslations('chat')
  const { user } = useAuth()
  const composerSubject = useChatStore((s) => s.composerSubject)
  const tFiles = useTranslations('files')

  if (!isAuthenticated) {
    return (
      <div
        className="flex flex-1 items-end justify-center px-4 pt-20 sm:pt-16"
        style={{ paddingBottom: `var(--welcome-offset, ${WELCOME_OFFSET_FALLBACK})` }}
      >
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <div className="bg-muted text-brand flex size-12 items-center justify-center rounded-xl border">
            <Lock className="size-5" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{t('chatArea.loggedOutTitle')}</h1>
          <p className="text-muted-foreground text-sm">{t('chatArea.loggedOutBody')}</p>
          <Button onClick={onSignIn} aria-label={t('chatArea.signInSso')}>
            {t('chatArea.signInSso')}
          </Button>
        </div>
      </div>
    )
  }

  const greeting = tChat(`greeting.${greetingKeyForHour(new Date().getHours())}`)
  const firstName = user?.name?.trim().split(/\s+/)[0]
  const heading = firstName ? tChat('greeting.withName', { greeting, name: firstName }) : greeting

  return (
    <div
      // Bottom-aligned against the composer's ACTUAL top edge — its height plus
      // however far it has been lifted off the floor, plus a gap, all published
      // as one measured number (`--welcome-offset`). That leaves the greeting
      // exactly one gap above the input by construction, whatever the lift
      // turns out to be and whatever this column's own top padding is. Both of
      // those defeated an earlier version that centred here and worked the
      // clearance out arithmetically: it omitted the `pt-20`, and the composer
      // landed on the greeting on a phone.
      className="flex flex-1 flex-col items-center justify-end px-6 pt-20 sm:pt-16"
      style={{ paddingBottom: `var(--welcome-offset, ${WELCOME_OFFSET_FALLBACK})` }}
    >
      {/* Hero greeting — the one larger moment in the app, and the only place
          the ramp's 23px step is used (design language, "Type ramp"). The
          project-grounded starters live in their own plan (categorized,
          backend-driven) — until they land, the canvas stays quiet rather
          than showing static examples. */}
      <h1 className="text-foreground text-center text-[23px] font-semibold tracking-tight">
        {heading}
      </h1>

      {/* The chat is about one file: say which. A named file is the state of
          THIS canvas, and it is not recoverable from anything else on
          screen. */}
      {composerSubject && (
        <p className="text-muted-foreground mt-2 max-w-md text-center text-sm leading-relaxed">
          {tFiles('assignment.welcomeAbout', {
            name: composerSubject.title?.trim() || tFiles('assignment.thisFile'),
          })}
        </p>
      )}

      {/* One sentence, and only in a project: that Piloti WRITES. The canvas is
          otherwise deliberately quiet (the starters were cut for costing every
          user on every new thread), and this earns its place because it is the
          product's least discoverable capability — today it is found only by
          someone who happens to phrase a request as a commission (ledger 23).
          Below the file line, because a named subject is the state of THIS
          canvas and this is a standing fact about the project.

          Not shown when the thread is about one file: that reader has already
          been told what this canvas is for, and two grey sentences under a
          greeting is a paragraph. */}
      {inProject && !composerSubject && (
        <p className="text-muted-foreground mt-3 max-w-md text-center text-sm leading-relaxed">
          {tChat('greeting.projectWrites')}
        </p>
      )}
    </div>
  )
}
