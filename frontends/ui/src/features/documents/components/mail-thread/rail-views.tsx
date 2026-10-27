'use client'

/**
 * The rail of a thread document, as two tabs: „E-Mails“ (the mails it holds,
 * `MailThreadTab`) and „Details“ (everything the rail says of any document).
 * For any other document it renders the rail's content untouched, so no
 * document that is not an E-Mail-Verlauf pays for a tab strip.
 *
 * „E-Mails“ is up when a thread document opens: for a conversation, the
 * mails are what the reader came for, and its Fassungen and approval are one
 * tap away. Details stays mounted while hidden (`forceMount`), as the peek's
 * two faces do, so switching back does not read the Fassungen again.
 */

import type { JSX, ReactNode } from 'react'
import { ListTree, Mail } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslations } from '@/i18n'

export type RailView = 'mail' | 'details'

export interface ThreadRailViewsProps {
  /** The tab's content; null for a document that is no E-Mail-Verlauf. */
  mail: ReactNode | null
  /** How many mails the thread holds, beside the tab's name. */
  mailCount: number
  value: RailView
  onValueChange: (next: RailView) => void
  detailsLabel: string
  children: ReactNode
}

export function ThreadRailViews({ mail, mailCount, value, onValueChange, detailsLabel, children }: ThreadRailViewsProps): JSX.Element {
  const t = useTranslations('mailThread')
  if (mail === null) return <>{children}</>
  return (
    <Tabs value={value} onValueChange={(next) => onValueChange(next === 'details' ? 'details' : 'mail')} className="min-h-0 gap-3">
      <TabsList aria-label={t('tab.views')} className="h-8 w-full shrink-0">
        <TabsTrigger value="mail" className="text-xs" data-testid="file-rail-tab-mail">
          <Mail aria-hidden className="size-3.5" />
          {t('tab.label')}
          <span className="tabular-nums" aria-hidden>
            {mailCount}
          </span>
          <span className="sr-only">({t('tab.count', { count: mailCount })})</span>
        </TabsTrigger>
        <TabsTrigger value="details" className="text-xs" data-testid="file-rail-tab-details">
          <ListTree aria-hidden className="size-3.5" />
          {detailsLabel}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="mail" className="mt-0 flex flex-col">
        {mail}
      </TabsContent>
      <TabsContent value="details" forceMount className="mt-0 flex flex-col data-[state=inactive]:hidden">
        {children}
      </TabsContent>
    </Tabs>
  )
}
