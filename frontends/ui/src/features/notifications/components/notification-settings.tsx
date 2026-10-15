'use client'

/**
 * "Benachrichtigungen" in the profile (ADR-0112): turn system notifications on
 * for this device, see and remove the devices that receive them, choose what
 * they are about, and choose whether the lock screen shows content.
 *
 * Split in two so the states can be looked at without a browser to produce
 * them: {@link NotificationSettings} reads the hook, {@link NotificationSettingsView}
 * draws a result of it and is what `/dev/notifications` renders from fixtures.
 *
 * A switch for this device, not a button: it is a standing state the person can
 * read back. Where the browser cannot (an old one, an iPhone outside the Home
 * Screen) or may not (the person said no) the section says so and what to do,
 * instead of a switch that does nothing.
 */

import type { JSX } from 'react'
import { Bell, BellOff, Info, Monitor, Smartphone, Tablet, X } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Item, ItemActions, ItemContent, ItemDescription, ItemList, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useLocale, useTranslations } from '@/i18n'
import { PUSH_CATEGORIES, type PushCategory } from '@/lib/inbox/push-categories'
import { formatRelativeTime } from '@/lib/format'
import type { PushDeviceView } from '@/lib/push/types'
import { usePushNotifications, type UsePushNotificationsResult } from '../hooks/use-push-notifications'

export function NotificationSettings(): JSX.Element | null {
  return <NotificationSettingsView push={usePushNotifications()} />
}

function DeviceIcon({ label }: { label: string }): JSX.Element {
  const Icon = /iPhone|Android-Smartphone/.test(label) ? Smartphone : /iPad|Android-Tablet/.test(label) ? Tablet : Monitor
  return <Icon className="size-4 text-muted-foreground" aria-hidden />
}

export function NotificationSettingsView({ push }: { push: UsePushNotificationsResult }): JSX.Element | null {
  const t = useTranslations('notifications')
  const { locale } = useLocale()
  const { phase } = push

  if (phase === 'off') return null

  const blocked = phase === 'unsupported' || phase === 'needs-install' || phase === 'denied'
  const blockedIcon = phase === 'denied' ? BellOff : phase === 'needs-install' ? Smartphone : Info
  const BlockedIcon = blockedIcon
  const hasDevices = push.devices.length > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-4 text-muted-foreground" aria-hidden />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {phase === 'loading' && (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
        )}

        {blocked && (
          <Alert variant="info">
            <BlockedIcon />
            <AlertTitle className="line-clamp-none">{t(`states.${stateKey(phase)}.title`)}</AlertTitle>
            <AlertDescription>{t(`states.${stateKey(phase)}.body`)}</AlertDescription>
          </Alert>
        )}

        {phase === 'ready' && (
          <Field orientation="horizontal">
            <div className="flex min-w-0 flex-col gap-1">
              <FieldLabel htmlFor="push-this-device">{t('device.label')}</FieldLabel>
              <FieldDescription>{push.busy ? t('device.working') : t('device.hint')}</FieldDescription>
            </div>
            <Switch
              id="push-this-device"
              checked={push.thisDeviceOn}
              disabled={push.busy}
              onCheckedChange={(next) => void (next ? push.enable() : push.disable())}
              aria-label={t('device.label')}
            />
          </Field>
        )}

        {push.error === 'enable' && <p role="alert" className="text-sm text-error">{t('device.failed')}</p>}
        {push.error === 'remove' && <p role="alert" className="text-sm text-error">{t('device.removeFailed')}</p>}

        {phase !== 'loading' && (
          <section aria-labelledby="push-devices-title" className="flex flex-col gap-2">
            <h3 id="push-devices-title" className="text-sm font-medium">
              {t('devices.title')}
            </h3>
            {hasDevices ? (
              <ItemList as="ul" className="bg-card">
                {push.devices.map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    isThis={device.id === push.thisDeviceId}
                    locale={locale}
                    busy={push.busy}
                    onRemove={() => void push.removeDevice(device.id)}
                  />
                ))}
              </ItemList>
            ) : (
              <p className="text-sm text-muted-foreground">{t('devices.empty')}</p>
            )}
          </section>
        )}

        {hasDevices && (
          <section aria-labelledby="push-categories-title" className="flex flex-col gap-4">
            <h3 id="push-categories-title" className="text-sm font-medium">
              {t('categories.title')}
            </h3>
            {PUSH_CATEGORIES.map((category) => (
              <CategoryField key={category} category={category} push={push} />
            ))}
            <Field orientation="horizontal">
              <div className="flex min-w-0 flex-col gap-1">
                <FieldLabel htmlFor="push-preview">{t('preview.label')}</FieldLabel>
                <FieldDescription>{t('preview.hint')}</FieldDescription>
              </div>
              <Switch
                id="push-preview"
                checked={push.preferences.showContent}
                disabled={push.busy}
                onCheckedChange={(showContent) => void push.updatePreferences({ showContent })}
                aria-label={t('preview.label')}
              />
            </Field>
            {push.error === 'preferences' && (
              <p role="alert" className="text-sm text-error">
                {t('preferencesFailed')}
              </p>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  )
}

function stateKey(phase: 'unsupported' | 'needs-install' | 'denied'): string {
  return phase === 'needs-install' ? 'needsInstall' : phase
}

function CategoryField({
  category,
  push,
}: {
  category: PushCategory
  push: UsePushNotificationsResult
}): JSX.Element {
  const t = useTranslations('notifications.categories')
  const id = `push-category-${category}`
  return (
    <Field orientation="horizontal">
      <div className="flex min-w-0 flex-col gap-1">
        <FieldLabel htmlFor={id}>{t(`${category}.label`)}</FieldLabel>
        <FieldDescription>{t(`${category}.hint`)}</FieldDescription>
      </div>
      <Switch
        id={id}
        checked={push.preferences.categories[category]}
        disabled={push.busy}
        onCheckedChange={(next) => void push.updatePreferences({ categories: { [category]: next } })}
        aria-label={t(`${category}.label`)}
      />
    </Field>
  )
}

function DeviceRow({
  device,
  isThis,
  locale,
  busy,
  onRemove,
}: {
  device: PushDeviceView
  isThis: boolean
  locale: string
  busy: boolean
  onRemove: () => void
}): JSX.Element {
  const t = useTranslations('notifications.devices')
  return (
    <Item as="li" className="hover:bg-transparent">
      <ItemMedia>
        <DeviceIcon label={device.label} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex items-center gap-2">
          <span className="truncate">{device.label}</span>
          {isThis && <Badge variant="secondary">{t('thisDevice')}</Badge>}
        </ItemTitle>
        <ItemDescription>
          {device.lastSuccessAt
            ? t('lastDelivered', { time: formatRelativeTime(device.lastSuccessAt, locale) })
            : t('neverDelivered')}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          variant="ghost"
          size="icon"
          disabled={busy}
          onClick={onRemove}
          aria-label={t('removeLabel', { device: device.label })}
        >
          <X aria-hidden />
        </Button>
      </ItemActions>
    </Item>
  )
}
