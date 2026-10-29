import * as pulumi from "@pulumi/pulumi";
import { objectName } from "./names";
import {
  type AgentWorkerConfig,
  type ApiConfig,
  type BackendConfig,
  loadChatTier,
} from "./config/chat-tier";
import { type DnsConfig, loadDns } from "./config/dns";
import { type DragonflyConfig, type RateLimitConfig, loadDragonfly } from "./config/dragonfly";
import { type ImagesConfig, loadImages } from "./config/images";
import { type LangfuseConfig, loadLangfuse, refuseLangfuseV4WriteMode } from "./config/langfuse";
import { type ObservabilityConfig, loadObservability } from "./config/observability";
import { type PostgresConfig, loadPostgres } from "./config/postgres";
import { type PosthogConfig, loadPosthog } from "./config/posthog";
import {
  type ChromaMigrationConfig,
  type QdrantConfig,
  loadChromaMigration,
  loadQdrantDashboard,
  loadQdrant,
  refuseRetiredVectorKeys,
} from "./config/qdrant";
import { bool, nodeGroup, num } from "./config/readers";
import { type SeaweedfsConfig, loadSeaweedfs } from "./config/seaweedfs";
import { type FrontendConfig, type WebConfig, loadWebTier } from "./config/web-tier";
import {
  type BffJobsConfig,
  type GeocoderConfig,
  type GotenbergConfig,
  type IngestWorkerConfig,
  type KedaConfig,
  type ProviderLimitsConfig,
  loadWorkers,
} from "./config/workers";
import {
  type AuthConfig,
  type InternalConfig,
  type LlmConfig,
  type SkillsConfig,
  type WebPushConfig,
  loadAppServices,
} from "./config/app-services";
import { type IngressConfig, loadIngress } from "./config/ingress";
export { GOTENBERG_SLOTS_PER_REPLICA, bffJobsMode, gotenbergCapacity, renditionCeiling } from "./rendition-sizing";

/**
 * Typed configuration for the Grid OIB Kubernetes deployment.
 *
 * Every tunable lives here or in a `config/` module named after its concern, so
 * the rest of the program never touches `pulumi.Config` directly. `loadConfig`
 * reads them in order and assembles `DeployConfig`. Set values with
 * `pulumi config set grid-oib:<key>` (add `--secret` for the secret ones). See
 * deploy/pulumi/README.md for the full list and docs/deployment/kubernetes.md
 * for the operator guide.
 *
 * Secret values are typed as `pulumi.Output<string>` — they stay encrypted in
 * the stack state and are only ever materialised inside k8s Secrets.
 */
export interface DeployConfig {
  namespace: string;
  /** Raw kubeconfig for the target cluster (from the provider). Secret. */
  kubeconfig: pulumi.Output<string>;

  images: ImagesConfig;

  storage: {
    /**
     * StorageClass backing every PVC. On the target cluster this is the
     * provider's Lightbits (NVMe/TCP) class — discover it with
     * `kubectl get storageclass`. The CSI driver is provider-installed; we only
     * reference the class by name.
     *
     * **Encryption at rest is NOT something this program can request.**
     * Kubernetes has no per-PVC encryption field: whether a volume is encrypted
     * is decided entirely by the StorageClass's `parameters`, which are fixed
     * when the class is created — and nothing in this repo creates a
     * StorageClass. So there is no config key here that could turn PVC
     * encryption on; inventing one would be a setting that does nothing.
     *
     * It is an OPERATOR action against the provider: obtain (or have the
     * provider create) a StorageClass whose backing volumes are encrypted, then
     * point this key at it. `kubectl get storageclass <name> -o yaml` shows the
     * parameters actually in force. See docs/deployment/kubernetes.md
     * § Encryption posture.
     */
    className: string;
  };

  ingress: IngressConfig;

  /**
   * Public DNS, managed in Cloudflare (`platform/dns.ts`).
   *
   * OFF by default, and off is a supported posture: a stack whose records are
   * maintained by hand deploys exactly as before. Turning it on replaces the
   * manual "read the LoadBalancer IP, retype it per host" step at the end of
   * every deploy — the step whose failure mode is a healthy cluster nobody can
   * reach and an ACME challenge that never solves.
   *
   * Cloudflare operates the zone; the registrar is irrelevant to this program
   * so long as the domain's NS records delegate there.
   */
  dns: DnsConfig;

  /**
   * Edge rate limiting — ADR-0040 layer L1. Enforced by Envoy Gateway's global
   * rate limit service against a dedicated counter store, so no application
   * implements it.
   *
   * Everything here is an ABUSE BOUND: fail-open by default, per client IP, per
   * route. Cost and quota live in other layers (ADR-0015 budgets, job
   * admission) and are deliberately not expressible here.
   */
  rateLimit: RateLimitConfig;

  postgres: PostgresConfig;

  dragonfly: DragonflyConfig;

  /**
   * Namespace-scoped NetworkPolicies: a default-deny for ingress into `grid`
   * plus least-privilege allows (edge→frontend/s3, intra-tier data access).
   * Egress stays open (the agent calls many external LLM/search endpoints).
   * On Cilium, kubelet health probes are not affected by these policies.
   */
  networkPolicies: boolean;

  /**
   * Pulumi `protect` on the resources whose loss is not recoverable by
   * re-running `pulumi up`: the CloudNativePG `Cluster` (the operator owns its
   * PVCs, so deleting the CR destroys the databases) and the SeaweedFS / Qdrant
   * StatefulSets (their PVCs are pinned `Retain`, but a delete is still a
   * full-outage event for object storage and the vector index).
   *
   * A protected resource makes Pulumi REFUSE to delete or replace it — a
   * mis-typed rename, a `pulumi destroy`, or an accidental immutable-field
   * change fails loudly with the resource still standing, instead of succeeding
   * quietly. Recovering is deliberate and auditable:
   * `pulumi state unprotect <urn>`.
   *
   * ON by default. Ephemeral stacks that are genuinely meant to be torn down
   * (a scratch dev cluster) set this false — see Pulumi.dev.yaml.
   */
  protectDataResources: boolean;

  /**
   * The worker group each placed tier runs on, as the value of the node label
   * `NODE_GROUP_LABEL` (`nodeGroupApp`, `nodeGroupData`, `nodeGroupBatch`).
   * Unset means no nodeSelector: the tier goes wherever the scheduler puts it,
   * which is every stack without worker groups. The groups themselves are made
   * in the IPAX Control Center, not here.
   *
   * Every pod template is placed: the stores (Postgres and its PgBouncers,
   * Qdrant, SeaweedFS, ClickHouse, Dragonfly) on data, ingestion (the ingest
   * workers, Gotenberg, the corpus import) on batch, everything else, Jobs
   * included, on app. The provider's volumes carry no node affinity, so a store
   * follows its PVC to the new group; a single-replica store is down while it
   * restarts there.
   *
   * With a data group set, the Postgres instances and the PgBouncers must sit on
   * different nodes (required anti-affinity, `DoNotSchedule` spread) rather than
   * prefer to: the group is fixed in size, so the rule cannot strand a replica
   * the way it could on a small, unplaced cluster.
   */
  nodeGroups: {
    app?: string;
    data?: string;
    batch?: string;
  };

  gotenberg: GotenbergConfig;

  /**
   * The self-hosted address search (ADR-0120, `data/geocoder.ts`): Photon over
   * the Austrian OSM extract. The frontend gets `GEOCODER_URL` exactly
   * when this is on; off, the project dialog's address stays a plain text field.
   */
  geocoder: GeocoderConfig;

  /**
   * The one-shot Job that moves the retired Chroma store into Qdrant
   * (`app/chroma-migration-job.ts`, the Qdrant runbook's "Migrating from
   * Chroma on Kubernetes"). Remove with the Job once every stack has run it.
   */
  chromaMigration: ChromaMigrationConfig;

  /**
   * Self-hosted Qdrant (ADR-0115), the only vector store, always deployed.
   * `docs/architecture/qdrant-retrieval-design.md` §9 is the reasoning behind
   * every default here; `data/qdrant.ts` is the manifest.
   */
  qdrant: QdrantConfig;

  seaweedfs: SeaweedfsConfig;

  /**
   * The chat tier (`aiq-agent`, `PROCESS_ROLE=chat`): CPU/memory here, replicas and
   * their scaling below, and the admission knobs that bound concurrent work.
   */
  backend: BackendConfig;

  /**
   * The api tier (ADR-0082 step B): `PROCESS_ROLE=api`, every backend HTTP route
   * except the chat socket (knowledge, jobs and SSE, LLM utilities, admin,
   * housekeeping). A Deployment of the backend image behind the `aiq-api`
   * Service, which is what `BACKEND_URL` names. HPA-owned, like the frontend:
   * the work is request-bound, so CPU is the signal, where the chat tier's
   * (`backend`) is running turns.
   */
  api: ApiConfig;

  frontend: FrontendConfig;

  /** The public website (apps/website) — a static-first Astro service; tiny resources. */
  web: WebConfig;

  /**
   * Enable the Dragonfly pub/sub conversation bus (ADR-0028) so the chat tier is
   * fully stateless — any replica serves any conversation's WebSocket. ON by
   * default (the intended architecture; uses REDIS_URL and fails open to local
   * delivery). Set false to fall back to conversation affinity, e.g. while
   * validating the bus cross-replica in a new environment.
   */
  conversationBus: boolean;
  agentWorker: AgentWorkerConfig;

  /**
   * The ingestion tier (ADR-0076): dedicated replicas that claim jobs from the
   * durable, fair ingest queue (`ingest_job_queue`), scaled by KEDA on its
   * depth. The chat and api roles only put jobs in the queue and never claim
   * them, so ingestion shares neither their CPU nor their GIL. Always deployed.
   */
  ingestWorker: IngestWorkerConfig;

  /**
   * The BFF's background pool (ADR-0079): internal-only replicas of the frontend
   * image that claim jobs from `bff_job_queue` fairly across organizations and
   * run them in their own BFF, so a reindex, a rescan (and later IFC parsing and
   * rendition) never shares a pod with the chat gateway. Scaled by KEDA on the
   * queue's depth, like the ingest tier.
   */
  bffJobs: BffJobsConfig;

  /**
   * KEDA, the event-driven autoscaler the ingest and bff-jobs tiers scale with.
   * Installed by this program unless the cluster already runs one
   * (`installKeda=false`).
   */
  keda: KedaConfig;

  /**
   * What the shared OpenRouter key is asked to carry (ADR-0076, ADR-0081), as
   * the backend image's environment. The four numbers are one budget:
   * {@link vlmPeakCalls} is held to `vlmFleetConcurrency` where the ingest tier
   * is sized (`assertVlmPeakFitsCeiling`), and `vlmFleetConcurrency` is held to
   * both ceilings a vision call passes: the key-wide `limitCeiling` and the
   * vision model's own `modelLimitCeiling` (a call takes a slot in each pool).
   */
  providerLimits: ProviderLimitsConfig;

  /** LLM / model-provider settings shared by backend + frontend. */
  llm: LlmConfig;

  /** WorkOS AuthKit + platform-tier settings (frontend). */
  auth: AuthConfig;

  /**
   * PostHog product analytics (fail-open).
   *
   * Both default to Piloti's project (`POSTHOG_DEFAULT_HOST`,
   * `POSTHOG_DEFAULT_PROJECT_TOKEN`), so every stack sends. An empty
   * `grid-oib:posthogHost` opts a stack out and keeps every client disabled
   * (`isPosthogEnabled() === false` in
   * `apps/workspace/bff/analytics/posthog.ts`). The project token is a public
   * `phc_` key by design (it ships in the client bundle), so it lives in plain
   * config like `workosClientId`, not in ESC secrets.
   */
  posthog: PosthogConfig;

  /** Cross-service internal token + admin token (must match across services). */
  internal: InternalConfig;

  /**
   * Web Push for the inbox (ADR-0112). All three empty = the feature is off.
   * Generate the pair with `npx web-push generate-vapid-keys --json` and set
   * `pulumi config set grid-oib:webPushVapidPublicKey`, `--secret
   * grid-oib:webPushVapidPrivateKey` and `grid-oib:webPushSubject`
   * (`mailto:` or `https:`). The public key is public by design.
   */
  webPush: WebPushConfig;

  skills: SkillsConfig;

  storageAlerts: {
    /**
     * The storage-quota warning sweep (ADR-0042).
     *
     * Enabled by default, unlike most gates here: the quota already REFUSES the
     * upload that would cross it, so with no alert the first person to learn
     * about the limit is whoever happens to break mid-task. A deployment that
     * sets no quota at all is unaffected — an org with no quota is skipped, so
     * the sweep costs one grouped aggregate per tick and emits nothing.
     */
    enabled: boolean;
    /**
     * Share of the quota at which the first warning goes out, as a percentage.
     * Reaches the frontend as `STORAGE_ALERT_THRESHOLD_PERCENT`. Escalation
     * to 90% and 100% is automatic and not configurable — "you have run out" is
     * a different message from "you are nearly out", and a computed step can
     * straddle 100%.
     */
    thresholdPercent: number;
    /**
     * 5-field cron for the sweep. Hourly by default: the condition it reports
     * changes on the timescale of an ingest, and the alert is suppressed while
     * it is already live, so a shorter period costs queries without telling
     * anybody anything new.
     */
    schedule: string;
  };

  vectorReconcile: {
    /**
     * The orphaned-vector sweep (`POST /api/internal/maintenance/reconcile-vectors`):
     * chunks whose document row is gone are deleted from the shared vector
     * store, and summary rows whose chunks are gone are forgotten. Enabled by
     * default for the reason the storage alert is: the orphans it recovers are
     * invisible in the product — a deleted file that still answers questions,
     * a listed file nobody can read — so nobody knows to start the manual run
     * on Platform → Vector maintenance.
     */
    enabled: boolean;
    /**
     * 5-field cron for the sweep. Weekly, off-peak, by default: every
     * collection is scanned each tick, and the store is written to only when
     * a past delete left something behind, so a tighter period costs scans
     * without recovering anything sooner than the next upload would notice.
     */
    schedule: string;
  };

  observability: ObservabilityConfig;

  /**
   * Langfuse — the DURABLE LLM-observability backend (ADR-0044).
   *
   * The consumer of the collector's traces signal: a queryable store that
   * answers "what did this user's run cost, which model served it, and how did
   * that change over the last month", and the live view of what the system is
   * doing now. It replaced the Aspire dashboard, an in-memory ring buffer that
   * answered only the second. ADR-0029 deferred exactly this and named the
   * collector as the seam it would arrive through.
   *
   * **Self-hosted OSS only.** No license key is configured anywhere in this
   * program, deliberately: everything wired here is MIT-licensed core Langfuse.
   * The consequence that matters operationally is that DATA RETENTION POLICIES
   * are an Enterprise feature, so trace data never expires on its own — see
   * `clickhouseStorageSize` and the ADR's Consequences section. (The server's
   * own diagnostic logs are the exception: `installClickHouse` TTL-bounds
   * those at 14 days. That covers ClickHouse chatter, not product data.)
   */
  langfuse: LangfuseConfig;

}

export function loadConfig(): DeployConfig {
  const cfg = new pulumi.Config();
  refuseLangfuseV4WriteMode(cfg.get("langfuseV4WriteMode"));

  // Reject the Pulumi.prod.yaml template placeholders up front. `require()`
  // happily returns "REPLACE_ME"/"app.example.com", so without this the failure
  // only surfaces ~20 min later as PVCs stuck Pending / TLS never issuing.
  const rejectPlaceholder = (key: string, markers: string[]) => {
    const v = cfg.get(key);
    if (v !== undefined && markers.some((m) => v.includes(m))) {
      throw new Error(
        `grid-oib:${key} is still the template placeholder ("${v}"). Set a real value before deploying.`,
      );
    }
  };
  rejectPlaceholder("storageClass", ["REPLACE_ME"]);
  // Single source for every public host: app/s3/langfuse subdomains derive from
  // baseDomain, so a domain move is a one-key change. The per-host keys
  // (appDomain/s3Domain/langfuseDomain) survive only as explicit overrides.
  const baseDomain = cfg.require("baseDomain");
  const appDomain = cfg.get("appDomain") ?? `app.${baseDomain}`;
  const s3Domain = cfg.get("s3Domain") ?? `s3.${baseDomain}`;
  // The landing site owns the apex: dev.piloti.at is the marketing/blog host,
  // the app lives at app.dev.piloti.at. `webDomain` survives only as an override.
  const webDomain = cfg.get("webDomain") ?? baseDomain;
  rejectPlaceholder("baseDomain", ["example.com"]);
  rejectPlaceholder("appDomain", ["example.com"]);
  rejectPlaceholder("s3Domain", ["example.com"]);
  rejectPlaceholder("webDomain", ["example.com"]);
  rejectPlaceholder("workosClientId", ["REPLACE_ME"]);
  // Let's Encrypt refuses ACME account registration for example.com contacts —
  // without this guard a deploy that fixed the domains but not the email passes
  // everything and then TLS silently never issues (the exact delayed-failure
  // class this guard exists to kill).
  rejectPlaceholder("letsEncryptEmail", ["example.com"]);
  rejectPlaceholder("langfuseDomain", ["example.com"]);
  rejectPlaceholder("qdrantDashboardDomain", ["example.com"]);

  // The BFF clamps a nonsense threshold back to 80 rather than switching the
  // warning off, which is the right runtime behaviour and a terrible deploy-time
  // one: an operator who set 800 meaning 80 would get the default forever and no
  // sign of it. Caught here, where there is somebody to read the message.
  const storageAlertThresholdPercent = num(cfg, "storageAlertThresholdPercent", 80);
  if (
    !Number.isFinite(storageAlertThresholdPercent) ||
    storageAlertThresholdPercent <= 0 ||
    storageAlertThresholdPercent > 100
  ) {
    throw new Error(
      `grid-oib:storageAlertThresholdPercent must be a percentage in (0, 100]; got ` +
        `"${storageAlertThresholdPercent}". This is the share of its storage quota at which an ` +
        "organization is warned (ADR-0042); escalation to 90% and 100% is automatic.",
    );
  }

  const chatTier = loadChatTier(cfg);

  const images = loadImages(cfg);

  const webTier = loadWebTier(cfg);

  const seaweedfs = loadSeaweedfs(cfg);

  const postgres = loadPostgres(cfg);

  const dragonflyStores = loadDragonfly(cfg);

  refuseRetiredVectorKeys(cfg);

  const appServices = loadAppServices(cfg);

  // ── Observability (ADR-0029): the collector, and what consumes it ─────────
  // `observabilityEnabled` is the product decision for the whole tier. The
  // collector is deployed when something consumes it (`collectorEnabled` in
  // `config/observability.ts`), never because the flag alone says so. The Aspire dashboard it used
  // to feed is gone (ADR-0100): traces go to Langfuse, logs to PostHog.
  // Dedicated WorkOS **Connect** application for the platform surfaces (now
  // Langfuse alone). REQUIRED — the app's own AuthKit client cannot be reused,
  // and this is not a preference:
  //
  //   Envoy Gateway hardcodes HTTP Basic auth for the token exchange
  //   (`internal/xds/translator/oidc.go`, "every OIDC provider supports basic
  //   auth"), with no SecurityPolicy field to change it. WorkOS's
  //   /user_management/authenticate ignores the Basic header and answers
  //   "Missing required parameter: client_id", so the flow dies at the
  //   callback with "OAuth flow failed." A Connect application's issuer
  //   (https://<tenant>.authkit.app) is a spec-complete OIDC provider that
  //   does accept client_secret_basic — and, as a bonus, needs no
  //   `provider=authkit` connection selector on /authorize.
  //
  // The application must be a CONFIDENTIAL client with a generated secret; a
  // public (PKCE-only) client has no secret and SecurityPolicy requires one.
  const otelOidcIssuer = (cfg.get("otelOidcIssuer") ?? "").replace(/\/+$/, "");
  const otelOidcClientId = cfg.get("otelOidcClientId") ?? "";
  const otelOidcClientSecret = cfg.getSecret("otelOidcClientSecret");
  const observabilityFlag = bool(cfg, "observabilityEnabled", true);
  const missingOidcDeps = [
    otelOidcIssuer === "" ? "otelOidcIssuer" : undefined,
    otelOidcClientId === "" ? "otelOidcClientId" : undefined,
    otelOidcClientSecret === undefined ? "otelOidcClientSecret" : undefined,
  ].filter((k): k is string => k !== undefined);

  const langfuse = loadLangfuse(cfg, baseDomain, missingOidcDeps, observabilityFlag);

  const qdrantDashboard = loadQdrantDashboard(cfg, baseDomain, missingOidcDeps);

  // ── Public DNS (Cloudflare) ────────────────────────────────────────────────
  //
  // Everything below is validated eagerly rather than at `installDns`, because
  // every one of these mistakes produces records that Cloudflare accepts and
  // reports as created. There is no failing resource to read afterwards — only
  // a name that resolves somewhere unhelpful, weeks later, to whoever tries it.
  const loadBalancerIp = cfg.get("loadBalancerIp");
  const dns = loadDns(cfg, loadBalancerIp, {
    webDomain,
    appDomain,
    s3Domain,
    langfuseDomain: langfuse.enabled ? langfuse.domain : undefined,
    qdrantDashboardDomain: qdrantDashboard.enabled ? qdrantDashboard.domain : undefined,
  });

  const posthog = loadPosthog(cfg, observabilityFlag);

  const observability = loadObservability(
    cfg,
    observabilityFlag,
    { otelOidcIssuer, otelOidcClientId, otelOidcClientSecret },
    {
      langfuseEnabled: langfuse.enabled,
      posthogLogsEnabled: posthog.logsEnabled,
      posthogMetricsEnabled: posthog.metricsEnabled,
    },
  );

  return {
    namespace: cfg.get("namespace") ?? objectName("namespace"),
    kubeconfig: cfg.requireSecret("kubeconfig"),

    images,

    storage: {
      className: cfg.require("storageClass"),
    },

    ingress: loadIngress(cfg, { appDomain, s3Domain, webDomain }, loadBalancerIp),

    dns,

    postgres,

    ...dragonflyStores,

    networkPolicies: bool(cfg, "networkPolicies", true),

    protectDataResources: bool(cfg, "protectDataResources", true),

    nodeGroups: {
      app: nodeGroup(cfg, "nodeGroupApp"),
      data: nodeGroup(cfg, "nodeGroupData"),
      batch: nodeGroup(cfg, "nodeGroupBatch"),
    },

    ...loadWorkers(cfg),

    chromaMigration: loadChromaMigration(cfg),

    qdrant: loadQdrant(cfg, qdrantDashboard),

    seaweedfs,

    ...chatTier,

    ...webTier,

    ...appServices,

    posthog,

    storageAlerts: {
      enabled: bool(cfg, "storageAlertsEnabled", true),
      thresholdPercent: storageAlertThresholdPercent,
      schedule: cfg.get("storageAlertSchedule") ?? "0 * * * *",
    },

    vectorReconcile: {
      enabled: bool(cfg, "vectorReconcileEnabled", true),
      // Sundays 03:00 UTC.
      schedule: cfg.get("vectorReconcileSchedule") ?? "0 3 * * 0",
    },

    observability,

    langfuse,
  };
}
