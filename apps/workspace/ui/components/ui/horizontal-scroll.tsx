'use client'

/**
 * A horizontal scroller that shows which way there is more.
 *
 * A wide table or drawing in a narrow column scrolls sideways, and on a phone
 * nothing said so: the comparison table's third column ended mid-letter at the
 * card edge and read as if it were not there. The edge that hides content
 * fades out, so the cut looks like a cut and not like the end.
 *
 * A mask, not an overlay: an overlay has to be painted in the colour of the
 * surface under it, and this sits on cards, answers and the page in both
 * themes. `mask-image` fades whatever is there.
 */

import { type HTMLAttributes, type ReactNode, useLayoutEffect, useRef, useState } from 'react'

import { ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

/** How far into the content each fade reaches. */
const FADE_PX = 28

interface Overflow {
  start: boolean
  end: boolean
}

const maskFor = ({ start, end }: Overflow): string | undefined => {
  if (!start && !end) return undefined
  const from = start ? `transparent, black ${FADE_PX}px` : 'black, black'
  const to = end ? `black calc(100% - ${FADE_PX}px), transparent` : 'black, black'
  return `linear-gradient(to right, ${from}, ${to})`
}

/** A small paper disc, so the chevron reads over whatever text the fade is cutting. */
const CUE_CLASS =
  'pointer-events-none absolute top-1/2 size-6 -translate-y-1/2 rounded-control border border-border bg-card p-1 text-muted-foreground shadow-xs'

export interface HorizontalScrollProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  /**
   * What is being scrolled, in the reader's language („Tabelle, seitlich
   * scrollbar"). Required: when the content overflows, the scroller becomes a
   * focusable, named region so a keyboard user can reach it and scroll it with
   * the arrow keys. A mouse or a touch scrolls it without focus; a keyboard
   * cannot, and the column that did not fit was simply out of reach.
   */
  'aria-label': string
  /**
   * Draw a chevron on each edge that hides content. A fade says "cut", a
   * chevron says "more this way": for a tab strip whose last entry is the one
   * the reader came for, and which a fade alone leaves looking merely clipped.
   */
  cue?: boolean
}

export function HorizontalScroll({
  children,
  className,
  style,
  'aria-label': label,
  cue = false,
  ...props
}: HorizontalScrollProps) {
  const ref = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState<Overflow>({ start: false, end: false })

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => {
      const start = element.scrollLeft > 1
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
      setOverflow((previous) =>
        previous.start === start && previous.end === end ? previous : { start, end }
      )
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    if (typeof ResizeObserver === 'undefined')
      return () => element.removeEventListener('scroll', update)
    const observer = new ResizeObserver(update)
    observer.observe(element)
    // The content is observed through a wrapper that lives as long as the
    // scroller. Observing the first child at mount watched an element the
    // caller could replace: a diagram's skeleton became its SVG, and a drawing
    // wider than the column never got its fade or its keyboard stop.
    if (content.current) observer.observe(content.current)
    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [])

  const mask = maskFor(overflow)
  // Only a scroller that actually scrolls is a stop in the tab order and a
  // landmark: every table in an answer as a named region would bury the ones
  // that need the keyboard among dozens that do not.
  const scrollable = overflow.start || overflow.end
  const scroller = (
    <div
      ref={ref}
      role={scrollable ? 'region' : undefined}
      tabIndex={scrollable ? 0 : undefined}
      aria-label={scrollable ? label : undefined}
      data-overflow-start={overflow.start || undefined}
      data-overflow-end={overflow.end || undefined}
      className={cn('overflow-x-auto', className)}
      style={mask ? { ...style, maskImage: mask, WebkitMaskImage: mask } : style}
      {...props}
    >
      {/* As wide as its content, and never narrower than the scroller: a
          wide table or drawing overflows through it, and a `w-full` child
          still fills the column. */}
      <div ref={content} className="w-fit min-w-full">
        {children}
      </div>
    </div>
  )
  if (!cue) return scroller
  return (
    <div className="relative">
      {scroller}
      {overflow.start && (
        <ChevronLeft
          aria-hidden
          className={CUE_CLASS + ' left-1'}
        />
      )}
      {overflow.end && (
        <ChevronRight
          aria-hidden
          className={CUE_CLASS + ' right-1'}
        />
      )}
    </div>
  )
}
