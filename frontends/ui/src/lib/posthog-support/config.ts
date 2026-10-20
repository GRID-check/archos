/**
 * Read the PostHog Support configuration from the server environment.
 *
 * Server only: the result carries the personal API key. `null` means Support
 * is not configured in this deployment, and the platform page shows the local
 * feedback log alone.
 */

import 'server-only'
import { posthogUiHost } from '@/lib/analytics/posthog-config'
import { configuredAppOrigin } from '@/lib/app-origin'
import type { PosthogSupportConfig } from './types'

/**
 * `NEXT_PUBLIC_POSTHOG_HOST` is the ingestion host the widget endpoint lives
 * on; the app host for the private API and ticket links is derived from it the
 * way the browser SDK derives `ui_host`.
 */
export function posthogSupportConfigFromEnv(
  env: Record<string, string | undefined>
): PosthogSupportConfig | null {
  const ingestHost = (env.NEXT_PUBLIC_POSTHOG_HOST ?? '').trim().replace(/\/+$/, '')
  const personalApiKey = (env.POSTHOG_PERSONAL_API_KEY ?? '').trim()
  const projectId = (env.POSTHOG_PROJECT_ID ?? '').trim()
  const projectToken = (env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? '').trim()
  if (!ingestHost || !personalApiKey || !projectToken || !/^\d+$/.test(projectId)) return null
  return {
    appHost: posthogUiHost(ingestHost),
    ingestHost,
    projectId,
    projectToken,
    personalApiKey,
    appOrigin: configuredAppOrigin(env),
  }
}
