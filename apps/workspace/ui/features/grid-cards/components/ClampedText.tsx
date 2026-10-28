'use client'

/**
 * ClampedText — a few lines of text that open on a tap when they were cut.
 *
 * A proposal's reason, a document's title and a task's title are what the
 * reader decides on. Cutting them at one or two lines keeps a card compact,
 * but the full text used to live in a `title` attribute, and a touch screen
 * never shows one (design-language.md, Touch: a hover reveal needs a
 * second way in). So the text is clamped, and only when the clamp really cut
 * something a "Mehr anzeigen" button appears under it. Text that fits shows no
 * button at all: nothing is added to a short title.
 *
 * The cut is MEASURED (`scrollHeight` against `clientHeight`) and re-measured
 * when the width changes, because the same card sits in the answer column, a
 * side panel and a phone, and only the rendered width says whether three words
 * wrapped to a second line or ten did.
 */

import { useLayoutEffect, useRef, useState, type ElementType } from 'react'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { cn } from '@/lib/utils'

/** Written out, because Tailwind reads class names from source, not from a template. */
const CLAMP: Record<1 | 2 | 3, string> = {
  1: 'line-clamp-1',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
}

interface ClampedTextProps {
  children: string
  /** Lines shown before the cut. */
  lines?: 1 | 2 | 3
  /** Type ramp, ink and wrapping of the text itself. */
  className?: string
  /** The text's element. A heading-like title stays a `p`, as it was. */
  as?: ElementType
}

export function ClampedText({ children, lines = 2, className, as: Tag = 'p' }: ClampedTextProps) {
  const t = useTranslations(chatCopy)
  const ref = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [children, lines, open])

  return (
    <>
      <Tag ref={ref} className={cn('break-words', !open && CLAMP[lines], className)}>
        {children}
      </Tag>
      {cut && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            // `touch-target` widens the catchment to 44px without opening a
            // visible gap under a caption-sized control; `self-start` because
            // the card's column would stretch it into a full-width bar.
            'touch-target card-caption text-muted-foreground hover:text-foreground self-start rounded -ml-1 px-1 py-0.5 font-medium',
            'transition-colors duration-quick ease-out',
            'focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2',
          )}
        >
          {open ? t('cards.clamp.less') : t('cards.clamp.more')}
        </button>
      )}
    </>
  )
}
