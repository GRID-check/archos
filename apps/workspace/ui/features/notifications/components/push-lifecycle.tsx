'use client'

/**
 * Mounted once in the signed-in app shell (ADR-0112). Renders nothing.
 *
 * It does three quiet things, and only when this deployment sends
 * notifications:
 *
 *   1. registers the service worker, so a browser that was allowed earlier can
 *      be reached the moment a push arrives, and a worker update is picked up;
 *   2. refreshes the registration of a device THIS person already turned on
 *      (the push service may have rotated the keys since);
 *   3. listens for the worker asking the page to go somewhere, which is how a
 *      tap on a notification reaches an open window the worker may not
 *      navigate itself.
 *
 * It never asks for permission and never subscribes: that is the person's click
 * (`usePushNotifications.enable`). It lives under the signed-in layout rather
 * than the root one so a signed-out visitor never gets a worker.
 */

import { useRouter } from 'next/navigation'
import { useEffect, type JSX } from 'react'
import { registerWorker } from '@/lib/push/browser'
import { refreshRegisteredDevice } from '../hooks/use-push-notifications'

export function PushLifecycle({ enabled }: { enabled: boolean }): JSX.Element | null {
  const router = useRouter()

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void registerWorker().then(async (registration) => {
      if (!registration || cancelled) return
      try {
        await refreshRegisteredDevice()
      } catch {
        // Offline or signed out mid-load: the next page load tries again.
      }
    })
    return () => {
      cancelled = true
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent): void => {
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null) return
      const { type, url } = data as { type?: unknown; url?: unknown }
      // The worker sends a path on this origin; anything else is not ours.
      if (type === 'piloti:navigate' && typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) {
        router.push(url)
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [enabled, router])

  return null
}
