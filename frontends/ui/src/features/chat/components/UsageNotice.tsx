/**
 * The usage notice above the composer: one budget window, before it stops this
 * person (`lib/budgets/usage-notice.ts` decides which, and at what level).
 *
 * It answers the three things a person needs at that moment: whose budget it
 * is, when it renews, and what they can do about it. Someone who can move the
 * binding limit gets a button to where it is edited; everyone else is told an
 * admin can, and where their usage is. Every level but `exhausted` can be
 * dismissed; that one is a fact about whether the next message will go out.
 *
 * Presentational: `ChatUsageNotice.tsx` reads and refreshes the notice, so the
 * /dev preview and the specs render exactly this.
 */

'use client'

import type { FC } from 'react'
import Link from 'next/link'
import { AlertTriangle, Ban, Gauge, TrendingUp, X, type LucideIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import type { MeterTone } from '@/components/ui/segment-meter'
import { useLocale, useTranslations } from '@/i18n'
import { formatCalendarDate, formatCredits, formatTimeOfDay, formatTokens } from '@/lib/format'
import type { ChatUsageNotice, UsageNoticeLevel } from '@/lib/budgets/usage-notice'

const LOOK: Record<
  UsageNoticeLevel,
  { variant: 'info' | 'warning' | 'destructive'; tone: MeterTone; icon: LucideIcon }
> = {
  forecast: { variant: 'info', tone: 'info', icon: TrendingUp },
  warning: { variant: 'warning', tone: 'warning', icon: Gauge },
  critical: { variant: 'warning', tone: 'destructive', icon: AlertTriangle },
  exhausted: { variant: 'destructive', tone: 'destructive', icon: Ban },
}

export interface UsageNoticeProps {
  notice: ChatUsageNotice
  /** Absent for an exhausted window, which cannot be dismissed. */
  onDismiss?: () => void
}

export const UsageNotice: FC<UsageNoticeProps> = ({ notice, onDismiss }) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const look = LOOK[notice.level]
  const Icon = look.icon
  const exhausted = notice.level === 'exhausted'

  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    notice.percent / 100
  )
  const budget = t(`usageNotice.budget.${notice.scope}.${notice.window}`)
  const time = formatTimeOfDay(notice.resetsAt, locale)
  const date = formatCalendarDate(notice.resetsAt, locale)
  const runsOut = notice.runsOutAt ? formatCalendarDate(notice.runsOutAt, locale) : null

  const amounts = notice.amounts
    ? notice.unit === 'token'
      ? t('usageNotice.amountsTokens', {
          used: formatTokens(notice.amounts.used, locale),
          limit: formatTokens(notice.amounts.limit, locale),
        })
      : t('usageNotice.amountsCredits', {
          used: formatCredits(notice.amounts.used, locale),
          limit: formatCredits(notice.amounts.limit, locale),
        })
    : null
  const renews =
    notice.window === 'day' ? t('usageNotice.renewsDay', { time }) : t('usageNotice.renewsMonth', { date })

  const sentences: Array<string | null> = exhausted
    ? [
        notice.window === 'day' ? t('usageNotice.blockedDay', { time }) : t('usageNotice.blockedMonth', { date }),
        notice.canChange ? null : t('usageNotice.askAdmin'),
      ]
    : [
        amounts ?? (notice.level === 'forecast' ? t('usageNotice.usedSoFar', { percent }) : null),
        notice.level === 'warning' && runsOut ? t('usageNotice.paceRunsOut', { date: runsOut }) : null,
        notice.level === 'critical' ? t('usageNotice.longRunsMayStop') : null,
        renews,
      ]

  const title = t(`usageNotice.title.${notice.level}`, { budget, percent, date: runsOut ?? date })

  return (
    <Alert
      variant={look.variant}
      // Only a spent budget interrupts a screen reader; the rest is news, not an alarm.
      role={exhausted ? 'alert' : 'status'}
      aria-live={exhausted ? 'assertive' : 'polite'}
      className="relative"
      data-testid="usage-notice"
      data-level={notice.level}
    >
      <Icon aria-hidden="true" />
      <AlertTitle className="line-clamp-none pr-6">{title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2 pr-6">
        <span>
          {sentences.filter(Boolean).join(' ')}{' '}
          {!notice.canChange && (
            <Link href={notice.href} className="text-foreground underline underline-offset-2">
              {t('usageNotice.seeUsage')}
            </Link>
          )}
        </span>
        {!exhausted && (
          <Progress
            value={notice.percent}
            tone={look.tone}
            className="h-1 max-w-sm"
            aria-label={t('usageNotice.meterLabel', { percent })}
          />
        )}
        {notice.canChange && (
          <Button asChild size="sm" variant="outline">
            <Link href={notice.href}>{t('usageNotice.raiseLimit')}</Link>
          </Button>
        )}
      </AlertDescription>
      {onDismiss && !exhausted && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onDismiss}
          aria-label={t('actions.dismiss')}
          className="absolute right-2 top-2"
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </Alert>
  )
}
