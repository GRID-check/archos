'use client'

/**
 * The Postfach docked beside the page (ADR-0153): the queue, worked next to
 * the real places its entries open.
 *
 * Following an entry replaces the page beside the dock with the entry's own
 * place (the chat at the message, the review at the mark) and the dock stays,
 * so the next entry is one click away and nothing is ever shown twice. The
 * shell owns where it sits and how wide it is (`startDock`, `DockedSplit`);
 * this is only what is in it.
 *
 * Everything the queue cannot show (the whole history, the archive) is one
 * link away on the Postfach page.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'

import { useTranslations } from '@/i18n'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { useStartDock } from '@/components/shell/start-dock'
import { useInboxBadge } from '../hooks/use-inbox'
import { InboxQueue } from './InboxQueue'

export function InboxDock(): JSX.Element {
  const t = useTranslations(collaborationCopy)
  const close = useStartDock((state) => state.close)
  const { pending } = useInboxBadge(true)

  return (
    <aside aria-labelledby="inbox-dock-title" className="flex h-full min-h-0 flex-col" data-testid="inbox-dock">
      <header className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
        <h2 id="inbox-dock-title" className="text-sm font-semibold">
          {t('inbox.title')}
        </h2>
        {pending > 0 && <CountPill count={pending} />}
        <Link
          href="/app/inbox?filter=all"
          className="ml-auto rounded-control text-xs text-muted-foreground hover:text-foreground touch-target"
          data-testid="inbox-dock-all"
        >
          {t('inbox.dock.all')}
        </Link>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label={t('inbox.dock.close')}
          title={t('inbox.dock.close')}
          onClick={close}
          data-testid="inbox-dock-close"
        >
          <X aria-hidden />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <InboxQueue returnHere={false} keyScope="self" />
      </div>
    </aside>
  )
}
