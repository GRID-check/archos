'use client'

/**
 * Usage-analytics opt-out (profile page).
 *
 * Product analytics keeps an identifier in this browser's cookie and local
 * storage (`lib/analytics/posthog.ts`), which is not strictly necessary, so a
 * person must be able to say no and mean it. The switch calls PostHog's own
 * opt-out: the choice is stored by the SDK in this browser, applies on every
 * later visit, and stops events and recordings before anything is queued.
 *
 * Per browser, not per account, on purpose: the thing being refused is the
 * storage and the traffic of THIS device. It is rendered only where the
 * deployment has analytics configured (decided on the server, so the page never
 * offers a switch that controls nothing).
 */

import { type FC, useCallback, useEffect, useState } from 'react'
import { ChartNoAxesColumn } from 'lucide-react'

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import { isPosthogOptedOut, optInPosthog, optOutPosthog } from '@/lib/analytics/posthog'

interface UsageAnalyticsSettingsProps {
  /** Whether this deployment has PostHog configured. Without it there is nothing to switch. */
  available: boolean
}

export const UsageAnalyticsSettings: FC<UsageAnalyticsSettingsProps> = ({ available }) => {
  const t = useTranslations('profile.usageAnalytics')
  // On until the SDK says otherwise: the server render cannot know this
  // browser's stored choice, and the first effect corrects it.
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    setEnabled(!isPosthogOptedOut())
  }, [])

  const handleChange = useCallback((next: boolean) => {
    if (next) optInPosthog()
    else optOutPosthog()
    setEnabled(next)
  }, [])

  if (!available) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChartNoAxesColumn className="size-4 text-muted-foreground" aria-hidden />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Field orientation="horizontal">
          <div className="flex min-w-0 flex-col gap-1">
            <FieldLabel htmlFor="usage-analytics-toggle">{t('label')}</FieldLabel>
            <FieldDescription>{t('hint')}</FieldDescription>
          </div>
          <Switch
            id="usage-analytics-toggle"
            checked={enabled}
            onCheckedChange={handleChange}
            aria-label={t('label')}
          />
        </Field>
      </CardContent>
    </Card>
  )
}
