'use client'

/**
 * A quiet offer in the inbox to turn notifications on for this device
 * (ADR-0112).
 *
 * Shown only where it can lead somewhere: the deployment sends notifications,
 * this browser can show them, the person has not turned this device on, has not
 * refused in the browser, and has not dismissed the offer. It never asks the
 * browser for anything by itself; the button is the person's click, and it is
 * the click that opens the browser's own prompt. A dismissal is remembered in
 * this browser (a convenience, so it comes back empty in a private window and
 * the offer then shows again).
 */

import { useCallback, useEffect, useState, type JSX } from 'react'
import { Bell, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { usePushNotifications, type UsePushNotificationsResult } from '../hooks/use-push-notifications'

const DISMISSED_KEY = 'piloti.push-prompt.dismissed'

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    // Private window or blocked storage: the offer simply shows again next time.
  }
}

export function NotificationPrompt({ className }: { className?: string }): JSX.Element | null {
  const push = usePushNotifications()
  const [dismissed, setDismissed] = useState(true)
  useEffect(() => setDismissed(readDismissed()), [])
  const dismiss = useCallback(() => {
    writeDismissed()
    setDismissed(true)
  }, [])
  return <NotificationPromptView push={push} dismissed={dismissed} onDismiss={dismiss} className={className} />
}

/** Whether the offer is worth making: ready to turn on, not on, not dismissed. */
export function promptIsDue(push: Pick<UsePushNotificationsResult, 'phase' | 'thisDeviceOn'>, dismissed: boolean): boolean {
  return push.phase === 'ready' && !push.thisDeviceOn && !dismissed
}

export function NotificationPromptView({
  push,
  dismissed,
  onDismiss,
  className,
}: {
  push: UsePushNotificationsResult
  dismissed: boolean
  onDismiss: () => void
  className?: string
}): JSX.Element | null {
  const t = useTranslations('notifications')
  if (!promptIsDue(push, dismissed)) return null
  return (
    <section
      aria-label={t('prompt.title')}
      className={cn(
        'flex items-start gap-3 rounded-lg border bg-card px-4 py-3.5 shadow-xs',
        'animate-in fade-in-0 duration-snap ease-out motion-reduce:animate-none',
        className
      )}
    >
      <Bell className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium">{t('prompt.title')}</p>
          <p className="text-pretty text-sm text-muted-foreground">{t('prompt.body')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" loading={push.busy} onClick={() => void push.enable()}>
            {t('prompt.turnOn')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t('prompt.dismiss')}
          </Button>
        </div>
        {push.error === 'enable' && (
          <p role="alert" className="text-sm text-error">
            {t('device.failed')}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="-mr-2 -mt-1.5 shrink-0"
        onClick={onDismiss}
        aria-label={t('prompt.dismissLabel')}
      >
        <X aria-hidden />
      </Button>
    </section>
  )
}
