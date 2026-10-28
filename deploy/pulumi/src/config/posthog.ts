/**
 * PostHog (ADR-0100): on by default in every stack; logs and metrics also need the collector.
 */
import * as pulumi from "@pulumi/pulumi";
import { bool } from "./readers";

/**
 * Piloti's PostHog project (EU Cloud, project 269895), the default for every
 * stack (ADR-0100). The token is the public `phc_` client key: it ships in
 * every browser bundle and can only write events, never read them. A stack
 * opts out with an empty `grid-oib:posthogHost`.
 */
export const POSTHOG_DEFAULT_HOST = "https://eu.i.posthog.com";

export const POSTHOG_DEFAULT_PROJECT_TOKEN = "phc_CVrz2Nt2hoJSmBQ9duYHDbWSjkdyQkQxKs7GHxDvg27X"; // pragma: allowlist secret

/** The same project's numeric id, for the private API (PostHog Support). */
export const POSTHOG_DEFAULT_PROJECT_ID = "269895";

/**
 * One signal the collector exports to PostHog (`key`, default on), resolved
 * against the dependencies both share. Warns only when the stack asked for the
 * signal by name: the default with the collector or PostHog switched off is
 * that stack's choice, not a mistake.
 */
function posthogExport(cfg: pulumi.Config, key: string, what: string, missing: string[]): boolean {
  const flag = bool(cfg, key, true);
  if (missing.length === 0) return flag;
  if (flag && cfg.get(key) !== undefined) {
    pulumi.log.warn(
      `PostHog ${what} not exported: missing ` +
        missing.map((k) => (k.includes(" ") ? k : `grid-oib:${k}`)).join(", ") +
        `. Set them to ship ${what} to PostHog, or set grid-oib:${key}=false to silence this.`,
    );
  }
  return false;
}

export interface PosthogConfig {
  /** Default `https://eu.i.posthog.com`. Empty = analytics disabled. */
  host: string;
  /** Public project token (`phc_…`), default Piloti's project. Empty = analytics disabled. */
  projectToken: string;
  /**
   * Whether the collector ships WARN-and-above logs to PostHog Logs: the
   * `posthogLogsEnabled` flag AND host AND token AND the `observabilityEnabled`
   * flag (the collector is the only sender, so without it there is nothing to
   * configure; this one is a consumer that brings the collector up). Default
   * on: only WARN and above leave, and PostHog's free tier is 10 GB of logs.
   */
  logsEnabled: boolean;
  /**
   * Whether the collector ships metrics to PostHog Metrics: the application
   * meters every tier sends over OTLP, and the cluster's own (nodes, pods,
   * containers, workload state, every scraped service). The
   * `posthogMetricsEnabled` flag AND the same three dependencies as
   * {@link logsEnabled}. Default on. Also what deploys the per-node agent
   * collector, which exists only to feed it.
   */
  metricsEnabled: boolean;
  /**
   * Whether the browser may record sessions (`grid-oib:posthogSessionReplay`,
   * default on, like the browser's own default). Text and inputs are masked,
   * the PDF and IFC viewers, media and signed URLs are blocked, and the privacy
   * notice names it (ADR-0100). Nothing records while PostHog itself is off.
   */
  sessionReplay: boolean;
  /**
   * Share of sessions recorded when replay is on, 0..1
   * (`grid-oib:posthogReplaySampleRate`, default 1). Lower it when the 5K
   * recordings a month of the free tier run out.
   */
  replaySampleRate: string;
  /**
   * The PostHog release the backend image belongs to
   * (`grid-oib:posthogReleaseId`, default empty). Not a commit: the id
   * `PostHog/resolve-release` prints, which the deploy workflow sets per run
   * with `pulumi config set`. The Python tiers get it as `POSTHOG_RELEASE_ID`,
   * which posthog-python sends as `$release_id`, so error tracking links each
   * exception to the release by id. Empty = no release link.
   */
  releaseId: string;
  /**
   * Personal API key for PostHog Support (`grid-oib:posthogPersonalApiKey`,
   * a secret in the stack's ESC environment; scopes `ticket:read`, `ticket:write`).
   * The BFF opens a Support ticket per feedback report and
   * lists and updates them on Platform -> Feedback
   * (`frontends/ui/src/lib/posthog-support/`). `undefined` when the stack
   * does not set it: then neither it nor `projectId` reaches a pod, and the
   * page shows the local feedback log only.
   */
  personalApiKey: pulumi.Output<string> | undefined;
  /**
   * Numeric project id for that API (`grid-oib:posthogProjectId`, default
   * `POSTHOG_DEFAULT_PROJECT_ID`). Only emitted alongside the key.
   */
  projectId: string;
}

export function loadPosthog(cfg: pulumi.Config, observabilityFlag: boolean): PosthogConfig {
  // ── PostHog: on by default in every stack (ADR-0100) ───────────────────────
  // The frontend, the Python tiers and the collector all read this one pair.
  // The SDK tiers capture with host + token alone (they no-op without them).
  // Both default to Piloti's project, so a stack sends unless it opts out with
  // an empty `posthogHost`; every event carries its `environment`, which keeps
  // staging apart from production in the one project.
  const posthogHost = cfg.get("posthogHost") ?? POSTHOG_DEFAULT_HOST;
  const posthogProjectToken = cfg.get("posthogProjectToken") ?? POSTHOG_DEFAULT_PROJECT_TOKEN;
  // Logs and metrics leave the cluster in bulk through the collector, so each
  // needs it as well as the pair. One check for both; each has its own flag.
  const missingPosthogExportDeps = [
    posthogHost === "" ? "posthogHost" : undefined,
    posthogProjectToken === "" ? "posthogProjectToken" : undefined,
    observabilityFlag ? undefined : "observabilityEnabled (the collector is what exports to PostHog)",
  ].filter((k): k is string => k !== undefined);
  const posthogLogsEnabled = posthogExport(cfg, "posthogLogsEnabled", "WARN+ logs", missingPosthogExportDeps);
  const posthogMetricsEnabled = posthogExport(cfg, "posthogMetricsEnabled", "metrics", missingPosthogExportDeps);
      return {
    host: posthogHost,
    projectToken: posthogProjectToken,
    logsEnabled: posthogLogsEnabled,
    metricsEnabled: posthogMetricsEnabled,
    sessionReplay: bool(cfg, "posthogSessionReplay", true),
    replaySampleRate: cfg.get("posthogReplaySampleRate") ?? "1",
    releaseId: (cfg.get("posthogReleaseId") ?? "").trim(),
    personalApiKey: cfg.getSecret("posthogPersonalApiKey"),
    projectId: (cfg.get("posthogProjectId") ?? POSTHOG_DEFAULT_PROJECT_ID).trim(),
  };
}
