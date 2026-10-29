/**
 * A long answer's list of sections, as a bottom sheet.
 *
 * A research report is ten `##` sections of German legal prose. On a phone the
 * reader reaches the middle of it by a citation, a table or a scroll, and had
 * no way to the next section short of scrolling past the ones in between. The
 * sheet lists every section (and its sub-sections) from the answer's own
 * markdown, with the same ids the renderer gives its headings
 * (`markdownHeadings`), and a tap closes it and scrolls to the one chosen.
 *
 * Two entries, one sheet. A quiet row above the prose says the answer has
 * sections and opens the list; every section heading carries the same entry
 * (`useOpenOutline`), so the way back is where the reader is. Both are for a
 * finger: a mouse has a scrollbar and the find bar, and a desktop answer is
 * exactly what it was.
 *
 * Offered only to a settled answer (headings that are still arriving are not a
 * map) and only when there is something to navigate: {@link MIN_SECTIONS} `##`
 * sections. A four-line reply has no outline.
 */

'use client'

import { type FC, type ReactNode, type RefObject, useMemo, useState } from 'react'
import { ChevronRight, TableOfContents } from 'lucide-react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { PRESSABLE } from '@/components/ui/press'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { cn } from '@/lib/utils'
import { markdownHeadings, type MarkdownHeading } from '@/shared/components/MarkdownRenderer/headings'
import { OutlineProvider } from '@/shared/components/MarkdownRenderer/outline-context'

/** `##` sections an answer needs before it is long enough to want a map. */
export const MIN_SECTIONS = 4

/** The headings an outline lists: sections and their sub-sections, in order. */
export const outlineHeadings = (markdown: string): MarkdownHeading[] => {
  const headings = markdownHeadings(markdown).filter((heading) => heading.level === 2 || heading.level === 3)
  const sections = headings.filter((heading) => heading.level === 2).length
  return sections >= MIN_SECTIONS ? headings : []
}

/** The element a heading id names, searched only inside this answer: two answers in a thread may both have „Zusammenfassung". */
const headingElement = (scope: HTMLElement | null, id: string): HTMLElement | null =>
  Array.from(scope?.querySelectorAll<HTMLElement>('h2, h3') ?? []).find((element) => element.id === id) ?? null

export const AnswerOutline: FC<{
  /** The answer's markdown, as rendered. */
  markdown: string
  /** The element holding the rendered answer: where the headings are looked up. */
  scopeRef: RefObject<HTMLElement | null>
  /** False while the answer arrives or has failed: no outline for a half-written report. */
  enabled: boolean
  children: ReactNode
}> = ({ markdown, scopeRef, enabled, children }) => {
  const t = useTranslations(chatCopy)
  const [open, setOpen] = useState(false)
  const headings = useMemo(() => (enabled ? outlineHeadings(markdown) : []), [enabled, markdown])
  const offered = headings.length > 0

  const sections = headings.filter((heading) => heading.level === 2).length
  const jump = (id: string): void => {
    setOpen(false)
    // After the sheet has let go of the page: a modal holds the scroll until it
    // closes, and a scroll issued under it goes nowhere.
    window.requestAnimationFrame(() => {
      const target = headingElement(scopeRef.current, id)
      if (!target) return
      const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      target.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' })
    })
  }

  return (
    // The provider and the slots below are ALWAYS rendered, offered or not: the
    // answer's own subtree sits inside them, and a wrapper that appeared at the
    // settle would remount the prose it holds.
    <OutlineProvider value={offered ? () => setOpen(true) : null}>
      {offered && (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="outline-entry"
        className={cn(
          'text-muted-foreground hover:text-foreground bg-muted/50 hidden min-h-11 w-full items-center gap-2 rounded-control px-3 text-left text-sm font-medium outline-none pointer-coarse:flex print:hidden',
          PRESSABLE,
          FOCUS_RING
        )}
      >
        <TableOfContents className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">{t('outline.label')}</span>
        <span className="text-xs font-normal tabular-nums">{t('outline.count', { count: sections })}</span>
        <ChevronRight className="size-4 shrink-0" aria-hidden />
      </button>
      )}
      {children}
      {offered && (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          closeLabel={t('outline.close')}
          data-testid="outline-sheet"
          className="max-h-[82dvh] gap-2 rounded-t-2xl px-0 pb-[max(1rem,env(safe-area-inset-bottom))] pt-5"
        >
          <SheetHeader className="px-5 pr-14">
            <SheetTitle className="text-base">{t('outline.title')}</SheetTitle>
            <SheetDescription className="sr-only">{t('outline.description')}</SheetDescription>
          </SheetHeader>
          <ol className="flex flex-col">
            {headings.map((heading) => (
              <li key={heading.id}>
                <button
                  type="button"
                  onClick={() => jump(heading.id)}
                  className={cn(
                    'text-foreground hover:bg-accent flex min-h-11 w-full items-center px-5 py-2 text-left outline-none',
                    heading.level === 3 ? 'text-muted-foreground pl-9 text-sm' : 'text-base font-medium',
                    PRESSABLE,
                    FOCUS_RING
                  )}
                >
                  {heading.text}
                </button>
              </li>
            ))}
          </ol>
        </SheetContent>
      </Sheet>
      )}
    </OutlineProvider>
  )
}
