'use client'

import type { JSX } from 'react'
import Link from 'next/link'
import { BellRing, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { intakeReadingStepCopy } from '@/i18n/namespaces/intake-reading-step'

/** The project's chat: usable from the first minute, whatever the reading is doing. */
export const projectChatHref = (projectId: string): string => `/app/projects/${encodeURIComponent(projectId)}/chat`

/**
 * The calm band at the foot of the step: one sentence on what the person need
 * not do (wait; Piloti tells them when it is done, `piloti.intake_ready`), and
 * the chat, which works now. Quiet on purpose: the one primary action is the
 * footer's.
 */
export function ReadingChatBand({
  projectId,
  message,
  notify,
  early,
}: {
  projectId: string
  message: string
  /** The reading still runs and Piloti will tell the person: the bell. */
  notify: boolean
  /** Piloti has not finished reading: the chat is „schon jetzt" there. */
  early: boolean
}): JSX.Element {
  const t = useTranslations(intakeReadingStepCopy)
  return (
    <div
      role="status"
      className="bg-muted flex flex-col gap-3 rounded-xl px-4 py-3.5 sm:flex-row sm:items-center"
      data-testid="reading-band"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
        {notify && <BellRing aria-hidden className="mt-0.5 size-[18px] shrink-0 sm:mt-0" />}
        <p className="min-w-0 text-sm">{message}</p>
      </div>
      <Button asChild variant="outline" className="bg-card h-11 shrink-0 text-[13px] sm:h-[34px] sm:px-3">
        <Link href={projectChatHref(projectId)} aria-label={t('chat.aria')} data-testid="reading-ask-chat">
          <MessageSquare aria-hidden className="size-3.5" />
          {early ? t('chat.early') : t('chat.label')}
        </Link>
      </Button>
    </div>
  )
}
