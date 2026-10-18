'use client'

/**
 * The composer's microphone. Press to record, press again (or wait 45 seconds)
 * to stop; the text arrives through `onTranscript`.
 *
 * Two pieces, because a phone needs both. {@link DictationControl} is the
 * button in the composer's control row: it keeps its place and its size in
 * every state, so the row never reflows under a thumb that is about to press
 * Stop. {@link DictationStrip} is what a touch screen shows while it records:
 * a full-width bar above the row with the level, the time against the limit,
 * and the whole bar as the target that ends the recording. With a mouse the
 * row control carries the level and the time itself and the strip stays out.
 *
 * When this browser cannot dictate, the button stays visible and says why: on
 * hover and keyboard focus through its tooltip, and on a tap through
 * `onExplain`, because a touch screen has no hover and a disabled button
 * answers a finger with nothing at all.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { Loader2, Mic, Square } from 'lucide-react'
import { AudioWave } from '@/components/ui/audio-wave'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import { MAX_DICTATION_SECONDS } from '@/lib/dictation/contract'
import { formatDurationElapsed } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useDictation, type DictationErrorKey, type DictationState } from '../hooks/use-dictation'

export interface DictationButtonProps {
  /** The UI language: a wording hint for the transcript, never its language. */
  locale: string
  /** The composer cannot take input right now (no permission, busy). */
  disabled?: boolean
  onTranscript: (text: string) => void
  /** A translated message for the composer's usual inline error. */
  onError: (message: string) => void
  /** A translated reason, when the reader taps a microphone this browser cannot use. */
  onExplain?: (reason: string) => void
  /** Where a {@link LiveDictationStrip} elsewhere in the composer reads this button's state. */
  channel?: DictationChannel
}

/** What one microphone is doing, and how to stop it: what the strip needs from the button. */
export interface DictationSnapshot {
  state: DictationState
  toggle: () => void
}

/**
 * The button's state, readable by a strip rendered somewhere else.
 *
 * A recording publishes a new level every 60ms. Lifting the hook into the
 * composer would re-render the whole composer at that rate; through this
 * channel only the button and the strip do.
 */
export interface DictationChannel {
  get: () => DictationSnapshot
  publish: (snapshot: DictationSnapshot) => void
  subscribe: (listener: () => void) => () => void
}

export function createDictationChannel(): DictationChannel {
  let snapshot: DictationSnapshot = { state: { phase: 'checking' }, toggle: () => {} }
  const listeners = new Set<() => void>()
  return {
    get: () => snapshot,
    publish: (next) => {
      snapshot = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** The hook and the row control in one; with a `channel`, a strip elsewhere follows it. */
export function DictationButton({
  locale,
  disabled = false,
  onTranscript,
  onError,
  onExplain,
  channel,
}: DictationButtonProps) {
  const t = useTranslations('chat')
  const { state, toggle } = useDictation({
    locale,
    onTranscript,
    onError: (key: DictationErrorKey) => onError(t(`dictation.errors.${key}`)),
  })
  useEffect(() => {
    channel?.publish({ state, toggle })
  }, [channel, state, toggle])
  return (
    <DictationControl
      state={state}
      locale={locale}
      disabled={disabled}
      onToggle={toggle}
      onExplain={onExplain}
    />
  )
}

export interface DictationControlProps {
  state: DictationState
  locale: string
  disabled?: boolean
  onToggle: () => void
  /** Called with the translated reason when an unavailable microphone is pressed. */
  onExplain?: (reason: string) => void
}

/** The button for one dictation state, with no behaviour of its own (the `/dev/dictation` preview draws each). */
export function DictationControl({
  state,
  locale,
  disabled = false,
  onToggle,
  onExplain,
}: DictationControlProps) {
  const t = useTranslations('chat')
  if (state.phase === 'unavailable' || state.phase === 'checking') {
    const reason = state.phase === 'unavailable' ? t(`dictation.unavailable.${state.reason}`) : t('dictation.start')
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* `aria-disabled`, not `disabled`: a disabled button fires no events,
              so a finger pressing it learned nothing. Pressing it now says why. */}
          <Button
            variant="ghost"
            size="icon"
            className="text-subtle size-[34px] cursor-not-allowed rounded-lg opacity-50"
            aria-disabled="true"
            aria-label={`${t('dictation.start')}: ${reason}`}
            onClick={() => {
              if (state.phase === 'unavailable') onExplain?.(reason)
            }}
            data-testid="dictation-unavailable"
          >
            <Mic className="size-4" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64">
          {reason}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (state.phase === 'recording') {
    const elapsed = formatDurationElapsed(state.elapsedSeconds, locale)
    return (
      <Button
        variant="ghost"
        size="sm"
        // On a touch screen the strip above the row carries the level and the
        // time, so the button stays a 44px square and the row does not reflow.
        className="text-destructive hover:text-destructive pointer-coarse:size-11 pointer-coarse:px-0 h-[34px] gap-1.5 rounded-lg px-2.5 tabular-nums"
        onClick={onToggle}
        aria-label={`${t('dictation.stop')} (${t('dictation.recording', { elapsed })})`}
        title={t('dictation.stop')}
        data-testid="dictation-recording"
      >
        <Square className="size-3 fill-current" aria-hidden="true" />
        <AudioWave levels={state.levels} className="pointer-coarse:hidden" />
        <span aria-hidden="true" className="pointer-coarse:hidden">
          {elapsed}
        </span>
      </Button>
    )
  }

  const busy = state.phase === 'starting' || state.phase === 'transcribing'
  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-subtle size-[34px] rounded-lg"
      onClick={onToggle}
      disabled={disabled || busy}
      aria-label={state.phase === 'transcribing' ? t('dictation.transcribing') : t('dictation.start')}
      aria-busy={busy}
      title={
        state.phase === 'transcribing'
          ? t('dictation.transcribing')
          : t('dictation.startHint', { seconds: MAX_DICTATION_SECONDS })
      }
      data-testid="dictation-button"
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <Mic className="size-4" aria-hidden="true" />
      )}
    </Button>
  )
}

export interface DictationStripProps {
  state: DictationState
  locale: string
  onToggle: () => void
  className?: string
}

/**
 * The recording, at the width of the composer: what a touch screen shows while
 * the microphone is open. Renders nothing outside recording and transcribing,
 * and nothing on a fine pointer (`pointer-coarse:flex`), where the row control
 * already shows the same two facts.
 */
export function DictationStrip({ state, locale, onToggle, className }: DictationStripProps) {
  const tCapture = useTranslations('capture')
  if (state.phase === 'transcribing') {
    return (
      <div
        role="status"
        data-testid="dictation-strip"
        className={cn(
          'bg-muted/70 text-muted-foreground pointer-coarse:flex mt-2 hidden min-h-12 items-center gap-3 rounded-lg px-3.5 text-sm',
          className
        )}
      >
        <Loader2
          className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        {tCapture('dictation.transcribing')}
      </div>
    )
  }
  if (state.phase !== 'recording') return null

  const elapsed = formatDurationElapsed(state.elapsedSeconds, locale)
  const limit = formatDurationElapsed(MAX_DICTATION_SECONDS, locale)
  const share = Math.min(1, state.elapsedSeconds / MAX_DICTATION_SECONDS)
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid="dictation-strip"
      // The whole bar is the Stop: the target a thumb finds without looking.
      aria-label={`${tCapture('dictation.tapToInsert')} (${elapsed})`}
      className={cn(
        'bg-muted/70 focus-visible:ring-ring/50 pointer-coarse:flex relative mt-2 hidden min-h-12 w-full items-center gap-3 overflow-hidden rounded-lg px-3.5 text-left focus-visible:outline-none focus-visible:ring-2 active:scale-[0.99] motion-reduce:active:scale-100',
        className
      )}
    >
      {/* A dot that breathes: the one sign the microphone is open. */}
      <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
        <span className="bg-destructive/50 absolute inset-0 animate-ping rounded-full motion-reduce:animate-none" />
        <span className="bg-destructive relative size-2.5 rounded-full" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="text-foreground text-sm font-medium">{tCapture('dictation.recording')}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {tCapture('dictation.elapsedOfLimit', { elapsed, limit })}
        </span>
      </span>
      <AudioWave levels={state.levels} className="text-foreground/70 h-5" />
      <span className="text-foreground shrink-0 text-xs font-semibold">
        {tCapture('dictation.tapToInsert')}
      </span>
      {/* How much of the limit is spent: a recording that stops by itself at
          45 seconds should not surprise anyone who could see it coming. */}
      <span
        aria-hidden="true"
        className="bg-foreground/25 duration-base absolute inset-x-0 bottom-0 h-0.5 origin-left transition-transform ease-out motion-reduce:transition-none"
        style={{ transform: `scaleX(${share.toFixed(3)})` }}
      />
    </button>
  )
}

/** {@link DictationStrip} following a {@link DictationButton} through its channel. */
export function LiveDictationStrip({ channel, locale }: { channel: DictationChannel; locale: string }) {
  const { state, toggle } = useSyncExternalStore(channel.subscribe, channel.get, channel.get)
  return <DictationStrip state={state} locale={locale} onToggle={toggle} />
}
