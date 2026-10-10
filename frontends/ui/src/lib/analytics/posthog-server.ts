/**
 * PostHog from the BFF — the server-side twin of `posthog.ts` (ADR-0098).
 *
 * Every server path that sends something to PostHog (answer feedback against
 * an LLM trace, a captured request error, a server-decided product event) goes
 * through this module, so there is one place that decides whether PostHog is
 * on and how a server event is shaped.
 *
 * Fail-open like the browser client: it reads the same
 * `NEXT_PUBLIC_POSTHOG_HOST` / `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` the layout
 * hands the browser, and with either unset every function is a no-op. The
 * project token is public by design, so the server needs no secret of its own
 * to capture.
 *
 * Server events carry no GeoIP: the caller is our cluster, not the user, so a
 * lookup would attribute every event to the data centre.
 */
import 'server-only'

import { PostHog } from 'posthog-node'

type ServerProperties = Record<string, unknown>

let client: PostHog | null = null
let resolved = false

const settings = (): { host: string; projectToken: string } | null => {
  const host = (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? '').trim().replace(/\/+$/, '')
  const projectToken = (process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? '').trim()
  if (!host || !projectToken) return null
  return { host, projectToken }
}

/** Whether the BFF sends anything to PostHog: both settings reached it. */
export const isPosthogServerEnabled = (): boolean => settings() !== null

/** The process-wide client, built on first use; `null` while PostHog is off. */
export const getPosthogServer = (): PostHog | null => {
  if (resolved) return client
  const config = settings()
  if (config) {
    client = new PostHog(config.projectToken, {
      host: config.host,
      disableGeoip: true,
      // Batch small: the BFF is long-lived, but a scale-down must not lose a
      // feedback vote that sat in a large buffer.
      flushAt: 20,
      flushInterval: 5_000,
    })
  }
  resolved = true
  return client
}

export interface ServerCapture {
  event: string
  /** The WorkOS user id. `null` sends a personless event (no person minted). */
  distinctId: string | null
  properties?: ServerProperties
  /** Group keys, e.g. `{ organization: orgId, project: projectId }`. */
  groups?: Record<string, string>
}

/** Queue one event; whether it was queued. Never throws. */
export const captureServer = ({ event, distinctId, properties, groups }: ServerCapture): boolean => {
  const posthog = getPosthogServer()
  if (!posthog) return false
  const props: ServerProperties = { ...properties }
  if (distinctId === null) props.$process_person_profile = false
  try {
    posthog.capture({
      event,
      distinctId: distinctId ?? `server:${event}`,
      properties: props,
      groups,
    })
    return true
  } catch (error) {
    console.debug('[posthog] could not queue event', event, error)
    return false
  }
}

/** Queue one `$exception`; whether it was queued. Never throws. */
export const captureServerException = (
  error: unknown,
  distinctId: string | null,
  properties?: ServerProperties,
): boolean => {
  const posthog = getPosthogServer()
  if (!posthog) return false
  const props: ServerProperties = { ...properties }
  if (distinctId === null) props.$process_person_profile = false
  try {
    posthog.captureException(error, distinctId ?? undefined, props)
    return true
  } catch (failure) {
    console.debug('[posthog] could not queue exception', failure)
    return false
  }
}

/** Flush and stop. Called from the shutdown path; safe to call twice. */
export const shutdownPosthogServer = async (): Promise<void> => {
  if (!client) return
  try {
    await client.shutdown()
  } catch (error) {
    console.debug('[posthog] shutdown failed', error)
  }
}

/** Forget the cached client so a spec can change the environment. */
export const resetPosthogServerForTests = (): void => {
  client = null
  resolved = false
}
