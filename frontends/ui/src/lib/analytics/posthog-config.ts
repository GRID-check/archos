/**
 * PostHog browser configuration — the part that is safe to import anywhere.
 *
 * Split from `posthog.ts` because the root layout (a server component) builds
 * this object from the environment on every request, and the viewers import
 * the replay block class; neither may pull `posthog-js` into its bundle. This
 * file imports nothing.
 *
 * Replay is ON unless the deployment turns it off, and every session is
 * recorded unless a sample rate says otherwise (owner decision, wave 2: the
 * signal is worth more than the headroom; the free tier holds 5K recordings a
 * month, so a busy deployment lowers `NEXT_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE`).
 *
 * The first-party proxy (`/ingest`, `app/ingest/[...path]/route.ts`) is ON by
 * default: events go to the app's own origin, which blockers leave alone and
 * which needs no third-party host in the privacy notice (`lib/legal/content`).
 */

/**
 * PostHog analytics configuration (fail-open). Empty host or token disables
 * the client. Produced server-side per request (layout `getAppConfig`) and
 * carried to the browser through `AppConfig`, so no rebuild is needed to
 * repoint a deployment.
 */
export interface PostHogConfig {
  /** Public PostHog host (e.g. `https://eu.i.posthog.com`). Empty = disabled. */
  host: string
  /** Public project token (`phc_…`). Empty = disabled. */
  projectToken: string
  /**
   * Whether session replay may record at all. Default on; text stays masked
   * (`buildSessionRecordingOptions`).
   */
  sessionReplay: boolean
  /** Share of sessions recorded when replay is on, 0..1. */
  replaySampleRate: number
  /**
   * Send events through this app's own `/ingest` route instead of straight to
   * {@link host}. Default on. The route reads the host at runtime, so the same
   * value must be set on the server that renders this config (it is: both
   * come from one environment).
   */
  proxy: boolean
}

/**
 * Who the server already knows the visitor is, handed to the browser so the
 * very first pageview is identified (PostHog `bootstrap`) and every event
 * carries the same non-personal context from the start.
 *
 * Non-personal by rule: the WorkOS user id (the pseudonym PostHog already
 * identifies with), ids and labels of the organization, the role slug and the
 * locale. No email, no name (pending the owner's explicit permission).
 */
export interface PostHogIdentity {
  /** WorkOS user id — the PostHog distinct id. */
  distinctId: string
  organizationId: string | null
  organizationName: string | null
  /** WorkOS role slug within the organization. */
  role: string | null
  locale: string
}

/** The disabled config: no host/token, every function in `posthog.ts` no-ops. */
export const DISABLED_POSTHOG_CONFIG: PostHogConfig = {
  host: '',
  projectToken: '',
  sessionReplay: false,
  replaySampleRate: 0,
  proxy: false,
}

/** Recorded share of sessions when `NEXT_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE` is unset or unusable. */
export const DEFAULT_REPLAY_SAMPLE_RATE = 1

/** The same-origin path the browser SDK talks to when the proxy is on. */
export const POSTHOG_PROXY_PATH = '/ingest'

/**
 * PostHog Cloud serves SDK assets (`/static/*`, `/array/*`) from a sibling
 * host: `eu.i.posthog.com` -> `eu-assets.i.posthog.com` (PostHog docs,
 * advanced/proxy/proxy-reference). Any other host (self-hosted, a custom
 * domain) serves them itself.
 */
export const posthogAssetHost = (host: string): string => {
  const trimmed = host.trim().replace(/\/+$/, '')
  return trimmed.replace(/^(https?:\/\/)(us|eu)\.i\.posthog\.com$/i, '$1$2-assets.i.posthog.com')
}

/**
 * The PostHog APP host for the toolbar, the heatmaps overlay and replay links.
 * With a proxy `api_host` is a path, so the SDK cannot guess it any more
 * (`ui_host`, PostHog docs, proxy-reference): `eu.i.posthog.com` ->
 * `eu.posthog.com`. A host that is not Cloud is its own app.
 */
export const posthogUiHost = (host: string): string => {
  const trimmed = host.trim().replace(/\/+$/, '')
  return trimmed.replace(/^(https?:\/\/(?:us|eu))\.i\.posthog\.com$/i, '$1.posthog.com')
}

/**
 * The class PostHog's recorder replaces with a grey placeholder and never
 * descends into (its documented default `blockClass`). Put on the containers
 * whose pixels or text layer ARE the document: the PDF viewer and the IFC
 * canvas. Text masking cannot cover them, because a canvas has no text to mask.
 */
export const REPLAY_BLOCK_CLASS = 'ph-no-capture'

/** A fraction in 0..1, or the default for anything else (empty, NaN, out of range). */
export const parseReplaySampleRate = (raw: string | undefined): number => {
  const text = (raw ?? '').trim()
  if (!text) return DEFAULT_REPLAY_SAMPLE_RATE
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || value > 1) return DEFAULT_REPLAY_SAMPLE_RATE
  return value
}

/** `true`/`1` is on, `false`/`0` is off, anything else (including unset) is `fallback`. */
const parseSwitch = (raw: string | undefined, fallback: boolean): boolean => {
  const text = (raw ?? '').trim().toLowerCase()
  if (text === 'true' || text === '1') return true
  if (text === 'false' || text === '0') return false
  return fallback
}

/**
 * Read the browser PostHog settings from the server environment. Called by the
 * root layout per request (see `posthog.ts` for why not at build time).
 */
export const postHogConfigFromEnv = (env: Record<string, string | undefined>): PostHogConfig => ({
  host: env.NEXT_PUBLIC_POSTHOG_HOST ?? '',
  projectToken: env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? '',
  sessionReplay: parseSwitch(env.NEXT_PUBLIC_POSTHOG_SESSION_REPLAY, true),
  replaySampleRate: parseReplaySampleRate(env.NEXT_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE),
  proxy: parseSwitch(env.NEXT_PUBLIC_POSTHOG_PROXY, true),
})
