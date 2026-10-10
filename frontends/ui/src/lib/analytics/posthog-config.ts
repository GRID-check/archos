/**
 * PostHog browser configuration — the part that is safe to import anywhere.
 *
 * Split from `posthog.ts` because the root layout (a server component) builds
 * this object from the environment on every request, and the viewers import
 * the replay block class; neither may pull `posthog-js` into its bundle. This
 * file imports nothing.
 *
 * Replay is OFF unless the deployment turns it on, and ON means "sampled":
 * the free tier holds 5K recordings a month, so an unsampled switch would
 * spend the allowance in a day on a busy office. The sample rate therefore has
 * a default (0.2) rather than an implicit "everything".
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
   * Whether session replay may record at all. Default off: replay is the one
   * capability that sees the screen, so a deployment opts in on purpose.
   */
  sessionReplay: boolean
  /** Share of sessions recorded when replay is on, 0..1. */
  replaySampleRate: number
}

/** The disabled config: no host/token, every function in `posthog.ts` no-ops. */
export const DISABLED_POSTHOG_CONFIG: PostHogConfig = {
  host: '',
  projectToken: '',
  sessionReplay: false,
  replaySampleRate: 0,
}

/** Recorded share of sessions when `NEXT_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE` is unset or unusable. */
export const DEFAULT_REPLAY_SAMPLE_RATE = 0.2

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

const isOn = (raw: string | undefined): boolean => {
  const text = (raw ?? '').trim().toLowerCase()
  return text === 'true' || text === '1'
}

/**
 * Read the browser PostHog settings from the server environment. Called by the
 * root layout per request (see `posthog.ts` for why not at build time).
 */
export const postHogConfigFromEnv = (env: Record<string, string | undefined>): PostHogConfig => ({
  host: env.NEXT_PUBLIC_POSTHOG_HOST ?? '',
  projectToken: env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? '',
  sessionReplay: isOn(env.NEXT_PUBLIC_POSTHOG_SESSION_REPLAY),
  replaySampleRate: parseReplaySampleRate(env.NEXT_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE),
})
