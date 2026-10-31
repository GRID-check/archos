'use client'

/**
 * The Postfach docked beside the page (ADR-0148): the queue, worked next to
 * the real places its entries open.
 *
 * Following an entry replaces the page beside the dock with the entry's own
 * place (the chat at the message, the review at the mark) and the dock stays,
 * so the next entry is one click away and nothing is ever shown twice. The
 * shell owns where it sits and how wide it is (`startDock`, `DockedSplit`);
 * this is only what is in it.
 *
 * It behaves as the disclosure its door says it is (`aria-expanded`): opened
 * by the reader, it takes the focus, so j/k work at once; Escape puts it away
 * and hands the focus back to the door. Restored after a reload it leaves the
 * focus where the page has it. A click anywhere in it focuses it too, so its
 * keys never wait for a Tab.
 *
 * It arrives by sliding in from its edge a few pixels as it fades: the width
 * itself changes in one frame, because animating it would re-lay out the page
 * beside it (a chat, a review) on every frame.
 *
 * Everything the queue cannot show (the whole history, the archive) is one
 * link away at its foot.
 */

import type { JSX, KeyboardEvent } from 'react'
import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { ArrowRight, X } from 'lucide-react'

import { useTranslations } from '@/i18n'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { Button } from '@/components/ui/button'
import { motion, motionEntrance, useMotionToken } from '@/components/motion'
import { focusStartDockDoor, useStartDock } from '@/components/shell/start-dock'
import { InboxQueue } from './InboxQueue'

export function InboxDock(): JSX.Element {
  const t = useTranslations(collaborationCopy)
  const close = useStartDock((state) => state.close)
  const takesFocus = useStartDock((state) => state.takesFocus)
  const focusTaken = useStartDock((state) => state.focusTaken)
  const arrive = useMotionToken(motionEntrance)
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!takesFocus) return
    rootRef.current?.focus({ preventScroll: true })
    focusTaken()
  }, [takesFocus, focusTaken])

  const putAway = (): void => {
    close()
    focusStartDockDoor('inbox')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    putAway()
  }

  return (
    <motion.aside
      ref={rootRef}
      tabIndex={-1}
      aria-labelledby="inbox-dock-title"
      className="flex h-full min-h-0 flex-col outline-none"
      data-testid="inbox-dock"
      data-queue-keys=""
      onKeyDown={onKeyDown}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={arrive}
    >
      <header className="flex shrink-0 items-center gap-2 py-2.5 pr-2 pl-5">
        <h2 id="inbox-dock-title" className="text-sm font-semibold">
          {t('inbox.title')}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-7 text-muted-foreground"
          aria-label={t('inbox.dock.close')}
          title={t('inbox.dock.close')}
          onClick={putAway}
          data-testid="inbox-dock-close"
        >
          <X aria-hidden />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-6">
        <InboxQueue returnHere={false} keyScope="self" />
      </div>
      <footer className="shrink-0 border-t px-3 py-2">
        <Link
          href="/app/inbox?filter=all"
          className="group/all flex items-center justify-between rounded-control px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-snap hover:bg-muted hover:text-foreground motion-reduce:transition-none"
          data-testid="inbox-dock-all"
        >
          {t('inbox.dock.all')}
          <ArrowRight
            className="size-3.5 transition-transform duration-snap group-hover/all:translate-x-0.5 motion-reduce:transition-none"
            aria-hidden
          />
        </Link>
      </footer>
    </motion.aside>
  )
}
