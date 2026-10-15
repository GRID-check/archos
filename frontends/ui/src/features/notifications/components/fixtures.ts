import { DEFAULT_PUSH_PREFERENCES } from '@/lib/inbox/push-categories'
import type { PushDeviceView } from '@/lib/push/types'
import type { UsePushNotificationsResult } from '../hooks/use-push-notifications'

/**
 * A hook result for the specs and for `/dev/notifications`, which draw the
 * states without a browser to produce them.
 */
export function pushFixture(overrides: Partial<UsePushNotificationsResult> = {}): UsePushNotificationsResult {
  const noop = async (): Promise<void> => undefined
  return {
    phase: 'ready',
    thisDeviceOn: false,
    devices: [],
    thisDeviceId: null,
    preferences: DEFAULT_PUSH_PREFERENCES,
    busy: false,
    error: null,
    enable: noop,
    disable: noop,
    removeDevice: noop,
    updatePreferences: noop,
    ...overrides,
  }
}

export const FIXTURE_DEVICES: PushDeviceView[] = [
  {
    id: 'd-iphone',
    label: 'Safari auf iPhone',
    endpoint: 'https://web.push.apple.com/a',
    createdAt: '2026-10-01T08:00:00.000Z',
    lastSuccessAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  },
  {
    id: 'd-laptop',
    label: 'Chrome auf Windows',
    endpoint: 'https://fcm.googleapis.com/fcm/send/b',
    createdAt: '2026-09-12T08:00:00.000Z',
    lastSuccessAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  },
  {
    id: 'd-old',
    label: 'Firefox auf Linux',
    endpoint: 'https://updates.push.services.mozilla.com/c',
    createdAt: '2026-09-30T08:00:00.000Z',
    lastSuccessAt: null,
  },
]
