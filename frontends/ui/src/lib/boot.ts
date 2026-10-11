/**
 * What this process is, in one line, at startup.
 *
 * ## The question this answers
 *
 * A pilot said a feature did not work. Nobody could say which build the pilot
 * was running, and nobody could say whether that feature was even switched on
 * for them: an organization can have no inbox, no sharing, no mentions, no
 * jobs and no skills — and the product looks, from the outside, exactly like
 * one where those things are broken. Three of the four feedback items in
 * `docs/audit/pilot-feedback-triage-2026-09.md` are indistinguishable from
 * "the flag was off".
 *
 * So: one line, first thing, on both services, naming the deployed commit and
 * where the flags come from. Plus `sha` on the health endpoints, so the
 * question can be answered about a RUNNING deployment without shell access to
 * read a log that has since rotated.
 *
 * ## Where the flags come from, not what each one says
 *
 * The line used to carry four env gates (`skills`, `collaboration`,
 * `enforceFlags`, `agentDocs`). Those are gone: every feature is a flag per
 * organization now (`lib/authz/feature-flags.ts`), so no process-wide value
 * exists to print. What a process CAN say is where its answers come from —
 * `flags=workos` wherever people sign in (`REQUIRE_AUTH=true`), `flags=defaults`
 * in a deployment that authenticates nobody, where every rollout is on and
 * every entitlement off. That is the first fork of any "the feature is not
 * there" report. `workos` names live evaluation and keeps its name although
 * the rollouts now come from PostHog (ADR-0102): the line is grepped across
 * replicas and `server.js` prints a byte-for-byte copy. The rule is duplicated
 * from `flagsAreLive` deliberately:
 * this module is imported by a health route and by nothing that has a session,
 * so it must not pull `next/server` or WorkOS in behind it.
 *
 * ## The CommonJS twin
 *
 * `server.js` prints the same line before Next.js is even built, and it is
 * plain CommonJS that cannot import this module (see its header). It carries a
 * byte-for-byte copy of {@link formatBootLine}'s output rules, and
 * `tests/lib/boot.test.ts` extracts that copy from the source and runs both
 * implementations over the same table — so a change to one that is not made to
 * the other fails a test instead of producing two different boot lines.
 */

/** Where this process's feature-flag answers come from. */
export type FlagSource = 'workos' | 'defaults'

/** What every field of the boot line is about. */
export interface BootFacts {
  sha: string
  flags: FlagSource
}

/** The value used when nothing stamped a commit into the image. */
export const UNKNOWN_SHA = 'unknown'

/**
 * The commit this image was built from, or {@link UNKNOWN_SHA}.
 *
 * `GRID_GIT_SHA` is stamped as a build arg by the image build and re-exported
 * as an env var (both Dockerfiles), so it survives into the running container
 * without a runtime lookup — there is no `.git` in the image to ask.
 */
export function deployedSha(env: NodeJS.ProcessEnv = process.env): string {
  const sha = (env.GRID_GIT_SHA ?? '').trim()
  return sha === '' ? UNKNOWN_SHA : sha
}

/**
 * `flagsAreLive`, for this process's env: live wherever people sign in.
 * The exact rule `isAuthRequired` applies — case-insensitive, NOT trimmed — so
 * the line cannot claim WorkOS for a value the gate reads as anonymous.
 */
export function flagSource(env: NodeJS.ProcessEnv = process.env): FlagSource {
  return (env.REQUIRE_AUTH ?? '').toLowerCase() === 'true' ? 'workos' : 'defaults'
}

/**
 * The boot line itself. One line, `[boot]`-prefixed, `key=value` pairs in a
 * fixed order — greppable across both services and across replicas, which a
 * pretty multi-line banner is not.
 */
export function formatBootLine(facts: BootFacts): string {
  return `[boot] sha=${facts.sha} flags=${facts.flags}`
}

/** {@link formatBootLine} for the current process. */
export function bootLine(env: NodeJS.ProcessEnv = process.env): string {
  return formatBootLine({ sha: deployedSha(env), flags: flagSource(env) })
}
