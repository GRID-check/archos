/**
 * Which push-service addresses we will POST to (ADR-0112).
 *
 * A subscription's endpoint is a URL the browser hands us, and the sender
 * requests it from inside the cluster with a signed header. A person who could
 * register `https://metadata.internal/…` would turn the push sender into a
 * request forger. So the endpoint must be a push service's, by host.
 *
 * The list is the services the browsers that implement Web Push use: Google's
 * (Chrome, Edge, Brave, Opera, Samsung Internet on Android), Mozilla's
 * (Firefox), Apple's (Safari and home-screen apps) and Microsoft's (legacy
 * Edge). A new push service is a one-line addition here, with the test, rather
 * than a runtime switch: the safe default for an unknown host is no.
 *
 * No `'server-only'`: the browser checks the same rule before it asks the
 * server, so a refusal reads the same on both sides.
 */

const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
  'push.microsoft.com',
] as const

/** Whether this is an https URL on a known push service, and nothing else. */
export function isPushServiceEndpoint(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  return PUSH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}
