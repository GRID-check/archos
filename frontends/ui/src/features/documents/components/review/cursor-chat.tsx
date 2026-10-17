'use client'

import { useEffect, useRef, useState, type JSX } from 'react'
import { identityInk } from '@/components/ui/avatar-identity'
import { useTranslations } from '@/i18n'
import { CURSOR_CHAT_MAX } from '@/lib/annotations/room-types'

/** How long a sent line stays beside the pointer after Enter, before it clears for everyone. */
export const CURSOR_CHAT_LINGER_MS = 4_000

/** The line still lingering from the last bubble: a new bubble takes over from it. One pointer, one line. */
let lingering: ReturnType<typeof setTimeout> | null = null

/**
 * Cursor chat, the way a design tool has it: „/" opens a bubble at this
 * reader's own pointer, and every key they type shows beside their pointer
 * for everyone in the room as they type it, no send button and nothing
 * stored. It is for the moment in a Jour fixe when „hier" needs a word, not
 * for anything to keep: that is an Anmerkung.
 *
 * Enter keeps the line a moment longer ({@link CURSOR_CHAT_LINGER_MS}), then
 * it goes; Esc and leaving the field take it away at once. The bubble follows
 * the pointer, so the words stay where the hand is.
 */
export function CursorChat({
  userId,
  from,
  onChat,
  onClose,
}: {
  /** Where the reader's pointer last was, in the window: the bubble opens there. */
  from: { x: number; y: number } | null
  /** This reader, for their own colour: the room sees the bubble in it. */
  userId: string | null
  /** Say the line (null: take it away). The room's `sendChat`. */
  onChat: (text: string | null) => void
  onClose: () => void
}): JSX.Element {
  const t = useTranslations('files')
  const [text, setText] = useState('')
  const [at, setAt] = useState<{ x: number; y: number } | null>(from)
  /** Closed once, by Enter, Esc or leaving the field: the rest is the linger's or nothing. */
  const done = useRef(false)
  const field = useRef<HTMLInputElement | null>(null)
  const onChatRef = useRef(onChat)
  useEffect(() => {
    onChatRef.current = onChat
  })
  // „/" is the reader asking for this field: it takes the keys at once, and the last line's linger ends.
  useEffect(() => {
    if (lingering) clearTimeout(lingering)
    lingering = null
    field.current?.focus()
  }, [])

  // The bubble rides with the pointer; until it moves, it sits where the reader last pointed.
  useEffect(() => {
    let frame = 0
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setAt({ x: event.clientX, y: event.clientY }))
    }
    window.addEventListener('pointermove', move)
    return () => {
      window.removeEventListener('pointermove', move)
      cancelAnimationFrame(frame)
    }
  }, [])

  // The bubble went without being closed (the review closed under it): its line goes with it.
  useEffect(
    () => () => {
      if (!done.current) onChatRef.current(null)
    },
    []
  )

  const ink = identityInk(userId ?? 'me')
  const finish = (keep: boolean) => {
    if (done.current) return
    done.current = true
    // The line outlives the bubble for a moment: the timer is the room's, not this component's.
    if (keep && text.trim()) {
      const say = onChatRef.current
      lingering = setTimeout(() => {
        lingering = null
        say(null)
      }, CURSOR_CHAT_LINGER_MS)
    }
    else onChat(null)
    onClose()
  }

  return (
    <div
      data-testid="cursor-chat"
      className="pointer-events-auto fixed z-50 w-60 rounded-2xl rounded-tl-sm px-3 py-2 text-white shadow-lg"
      style={{
        backgroundColor: ink,
        ...(at ? { left: at.x + 14, top: at.y + 16 } : { left: '50%', bottom: '6rem', transform: 'translateX(-50%)' }),
      }}
    >
      <input
        ref={field}
        aria-label={t('review.chatOpen')}
        data-testid="cursor-chat-input"
        maxLength={CURSOR_CHAT_MAX}
        value={text}
        placeholder={t('review.chatPlaceholder')}
        className="w-full rounded-md border-0 bg-transparent px-1 text-sm leading-5 font-medium text-white shadow-none placeholder:text-white/70"
        // The app's focus outline stays (WCAG 2.4.11), in white on the bubble's colour, hugging the words.
        style={{ outlineColor: 'rgb(255 255 255 / 0.75)', outlineOffset: 1 }}
        onChange={(event) => {
          setText(event.target.value)
          onChat(event.target.value || null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            finish(false)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            finish(true)
          }
        }}
        onBlur={() => finish(true)}
      />
      <p className="mt-0.5 text-[10px] leading-3 text-white/75">{t('review.chatHint')}</p>
    </div>
  )
}
