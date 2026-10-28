/**
 * The Qdrant tier (ADR-0115), its dashboard at the edge, and the one-shot Chroma migration.
 */
import * as pulumi from "@pulumi/pulumi";
import { QDRANT } from "../constants";
import {
  bool,
  percent,
  positiveInt,
  requireSecretsTogether,
} from "./readers";

/**
 * `storage.low_memory_mode` (Qdrant 1.19): how segments load at start. A
 * recovery knob for a peer that OOMs while loading, never a steady state.
 */
export const QDRANT_LOW_MEMORY_MODES = ["no_resident", "no_populate"] as const;

export type QdrantLowMemoryMode = (typeof QDRANT_LOW_MEMORY_MODES)[number];

/**
 * Stack keys of the retired Chroma tier and of the Chroma-to-Qdrant switch
 * (ADR-0115). Qdrant is the only vector store, always deployed, so each of
 * these either does nothing or asks for a store this program no longer runs;
 * `loadConfig` refuses a stack that still sets one, rather than leave it to
 * read as a setting.
 */
export const RETIRED_VECTOR_KEYS = [
  "chromaEnabled",
  "chromaImage",
  "chromaStorageSize",
  "qdrantEnabled",
  "vectorBackend",
] as const;

/**
 * A stack that still sets a key of the retired Chroma tier or of the switch
 * between the two stores. `qdrantEnabled: false` would read as "no Qdrant"
 * and `vectorBackend: chroma` as "reads stay on Chroma"; neither is true any
 * more, so the plan stops and names the keys to remove.
 */
export function refuseRetiredVectorKeys(cfg: pulumi.Config): void {
  const set = RETIRED_VECTOR_KEYS.filter((key) => cfg.get(key) !== undefined);
  if (set.length === 0) return;
  throw new Error(
    `${set.map((k) => `grid-oib:${k}`).join(", ")} ${set.length === 1 ? "is" : "are"} retired: Qdrant is ` +
      "the only vector store and always deployed, and Chroma is gone (ADR-0115). Remove " +
      `${set.length === 1 ? "it" : "them"} with \`pulumi config rm\`. To move the old Chroma data, see ` +
      '`chromaMigration` (docs/deployment/qdrant-runbook.md, "Migrating from Chroma on Kubernetes").',
  );
}

/** The one-shot Chroma-to-Qdrant Job (`app/chroma-migration-job.ts`). */
export function loadChromaMigration(cfg: pulumi.Config): ChromaMigrationConfig {
  return {
    enabled: bool(cfg, "chromaMigration", false),
    scratchSize: cfg.get("chromaMigrationScratchSize") ?? "50Gi",
    timeoutMinutes: positiveInt(cfg, "chromaMigrationTimeoutMinutes", 40),
  };
}

/**
 * The Qdrant tier (ADR-0115), validated together because each refusal below
 * would otherwise deploy cleanly and be wrong.
 */
export function loadQdrant(cfg: pulumi.Config, dashboard: QdrantConfig["dashboard"]): QdrantConfig {
  const replicas = positiveInt(cfg, "qdrantReplicas", 3);
  if (replicas === 2) {
    throw new Error(
      "grid-oib:qdrantReplicas=2 is refused: two Raft voters lose quorum when either fails, so the " +
        "cluster tolerates no more failures than one peer and has twice the ways to stop. Use 3, or 1 " +
        "on a small stack.",
    );
  }
  const retentionDays = positiveInt(cfg, "qdrantSnapshotRetentionDays", 7);
  const schedule = cfg.get("qdrantSnapshotSchedule") ?? "30 1 * * *";
  if (schedule.trim().split(/\s+/).length !== 5) {
    throw new Error(`grid-oib:qdrantSnapshotSchedule must be a 5-field cron expression (got "${schedule}").`);
  }
  assertQdrantSecrets(cfg);
  const quotas = {
    memoryPercent: percent(cfg, "qdrantQuotaMemoryPercent", 90),
    diskPercent: percent(cfg, "qdrantQuotaDiskPercent", 85),
  };
  const lowMemoryMode = cfg.get("qdrantLowMemoryMode")?.trim() || undefined;
  const knownMode = QDRANT_LOW_MEMORY_MODES.find((m) => m === lowMemoryMode);
  if (lowMemoryMode && !knownMode) {
    throw new Error(
      `grid-oib:qdrantLowMemoryMode must be one of ${QDRANT_LOW_MEMORY_MODES.join(", ")} (got "${lowMemoryMode}"); ` +
        "remove the key for Qdrant's default. An unknown value stops every peer at start.",
    );
  }
  return {
    image: cfg.get("qdrantImage") ?? "qdrant/qdrant:v1.19.2",
    replicas,
    cpu: cfg.get("qdrantCpu") ?? "4",
    memory: cfg.get("qdrantMemory") ?? "16Gi",
    storageSize: cfg.get("qdrantStorageSize") ?? "100Gi",
    apiKey: cfg.getSecret("qdrantApiKey") ?? pulumi.secret(""),
    readOnlyApiKey: cfg.getSecret("qdrantReadOnlyApiKey") ?? pulumi.secret(""),
    altApiKey: (cfg.get("qdrantAltApiKey") ?? "").trim() ? cfg.requireSecret("qdrantAltApiKey") : undefined,
    lowMemoryMode: knownMode,
    quotas,
    snapshots: {
      schedule,
      retentionDays,
      s3AccessKey: cfg.get("qdrantS3AccessKey") ?? QDRANT.s3Identity,
      s3SecretKey: cfg.getSecret("qdrantS3SecretKey") ?? pulumi.secret(""),
    },
    dashboard,
  };
}

/**
 * The three Qdrant credentials: present, and each its own value. Compared,
 * never printed — only key NAMES reach a message.
 */
function assertQdrantSecrets(cfg: pulumi.Config): void {
  requireSecretsTogether(
    cfg,
    ["qdrantApiKey", "qdrantReadOnlyApiKey", "qdrantS3SecretKey"],
    "(Qdrant is always deployed, and open-source Qdrant answers anyone without a key; " +
      "generate each with `openssl rand -base64 32`)",
  );
  const raw = (key: string) => (cfg.get(key) ?? "").trim();
  // The read-only key is the one a search-only caller holds. Equal to the
  // read-write key, it is a read-write key under another name.
  if (raw("qdrantApiKey") === raw("qdrantReadOnlyApiKey")) {
    throw new Error(
      "grid-oib:qdrantReadOnlyApiKey must differ from grid-oib:qdrantApiKey: a request carrying it would " +
        "match the read-write key, so every holder of the read-only key could write.",
    );
  }
  // The rotation key is a read-write key: equal to the read-only one, every
  // holder of the read-only key could write.
  if (raw("qdrantAltApiKey") && raw("qdrantAltApiKey") === raw("qdrantReadOnlyApiKey")) {
    throw new Error(
      "grid-oib:qdrantAltApiKey must differ from grid-oib:qdrantReadOnlyApiKey: the peers accept it as a " +
        "read-write key, so every holder of the read-only key could write.",
    );
  }
  // SeaweedFS authenticates by key, so a shared secret hands this identity
  // another's scope: for `seaweedfsSecretKey`, object CRUD on every tenant bucket.
  const s3Collides = [
    "seaweedfsSecretKey",
    "seaweedfsBackendReadSecretKey",
    "seaweedfsTenantAdminSecretKey",
    "langfuseS3SecretKey",
  ].find((other) => raw(other) === raw("qdrantS3SecretKey"));
  if (s3Collides) {
    throw new Error(
      `grid-oib:qdrantS3SecretKey must differ from grid-oib:${s3Collides}. SeaweedFS authenticates by key, ` +
        "so a shared secret gives the Qdrant snapshot identity that identity's bucket scope instead of " +
        "its own single bucket.",
    );
  }
}

export interface ChromaMigrationConfig {
  /**
   * Run the Job. OFF by default. On for the deploy that removes Chroma: the
   * Job reads the Chroma server that deploy still runs, and the backend
   * tiers roll only once it has completed. It runs once while on.
   */
  enabled: boolean;
  /**
   * The scratch volume the exporter writes and the importer reads, a
   * generic ephemeral claim that stays with the pod. It holds the export,
   * about 16 KB per chunk at 3072 dimensions (12 KB of float32 vector, the
   * text and its metadata), and about 2 GiB for the `chromadb` environment
   * uv installs.
   */
  scratchSize: string;
  /**
   * How long `pulumi up` waits for the Job before it fails the deploy (the
   * backend tiers have not rolled then, and Chroma is not deleted). 40 by
   * default: the staging pipeline stops at 60 minutes, and the rest of a
   * deploy takes about 6. Raise it only for an `up` run outside that
   * pipeline.
   */
  timeoutMinutes: number;
}

export interface QdrantConfig {
  /**
   * Pinned. Self-hosted Qdrant cannot skip a minor on upgrade, and a snapshot
   * restores only into the same or the next minor, so the version moves one
   * minor at a time and never by accident.
   */
  image: string;
  /**
   * Peers. 3 keeps Raft quorum through one failure; 1 is for small stacks and
   * runs without cluster mode. 2 is refused: it tolerates no failure and
   * doubles the ways to lose quorum.
   */
  replicas: number;
  /** CPU per peer, request = limit. */
  cpu: string;
  /**
   * Memory per peer, request = limit. OOM during segment optimisation is the
   * most reported Qdrant failure, and a limit above the request is memory
   * the scheduler never promised.
   */
  memory: string;
  /** Data PVC per peer. Size it at 2x the data: snapshots are staged on it. */
  storageSize: string;
  /** `service.api_key`: read and write, and the only key peers accept on p2p. */
  apiKey: pulumi.Output<string>;
  /** `service.read_only_api_key`: search only. Must differ from `apiKey`. */
  readOnlyApiKey: pulumi.Output<string>;
  /**
   * `service.alt_api_key`: a second read-write key the peers accept, on the
   * API and on p2p, while the first is rotated (the runbook's "Rotate the
   * API key"). Undefined outside a rotation, and then no env var is set.
   */
  altApiKey: pulumi.Output<string> | undefined;
  /**
   * `storage.low_memory_mode` for every peer, or undefined (Qdrant's
   * `disabled`). Set only to get a peer that OOMs while loading its segments
   * back up, then removed (the runbook's "OOM crash loop").
   */
  lowMemoryMode: QdrantLowMemoryMode | undefined;
  /**
   * The cluster-wide resource quotas (`storage.quotas`, Qdrant 1.19): above
   * either percentage a peer refuses writes with HTTP 507 instead of being
   * OOM-killed or filling its volume, and reports `quota_exceeded{resource}`.
   * They SEED the quota manager on a cluster's first start only; afterwards
   * Qdrant keeps them in consensus (`quota.json`), so a changed value here
   * reaches a running cluster through `PUT /quotas` (the runbook's
   * "Quotas"), not through a deploy.
   */
  quotas: {
    /** Resident memory as a percentage of the cgroup limit. */
    memoryPercent: number;
    /** Use of the data volume's filesystem, in percent. */
    diskPercent: number;
  };
  snapshots: {
    /** 5-field cron for the `qdrant-snapshot` CronJob. */
    schedule: string;
    /** Snapshots older than this many days are deleted by the same CronJob. */
    retentionDays: number;
    /** Access key of the `grid-qdrant` S3 identity (object CRUD on the snapshot bucket). */
    s3AccessKey: string;
    s3SecretKey: pulumi.Output<string>;
  };
  /**
   * Qdrant's built-in web dashboard on a public host, behind the platform
   * operator gate (`platform/qdrant-dashboard.ts`). On by default, wherever
   * the stack has the `otelOidc*` Connect application that gates it; off, no
   * listener, certificate, DNS record, route, SecurityPolicy or NetworkPolicy
   * exists for it, and operators port-forward instead.
   */
  dashboard: {
    /**
     * `qdrantDashboardEnabled` (default true) AND the Connect application.
     * Without the application the route is skipped with a warning, unless the
     * flag was set to true explicitly, which fails the plan.
     */
    enabled: boolean;
    /** Public hostname. Derived: `qdrant.<baseDomain>` unless overridden. */
    domain: string;
  };
}

export function loadQdrantDashboard(
  cfg: pulumi.Config,
  baseDomain: string,
  missingOidcDeps: string[],
): QdrantConfig["dashboard"] {
  // ── Qdrant dashboard at the edge (platform/qdrant-dashboard.ts) ────────────
  // On by default, like Langfuse, and on the same rule: the flag AND the
  // capability. The capability is the platform Connect application, because
  // the gate is the only thing between the public host and every office's
  // chunk text; a route planned with an empty issuer would put that host on
  // the internet ungated by anything that works. So a stack without the
  // `otelOidc*` keys gets no route and a warning, never an open one. A stack
  // that sets the flag to true explicitly asked for the route, and is failed
  // instead: there the missing gate is a mistake, not a default.
  const qdrantDashboardDomain = cfg.get("qdrantDashboardDomain") ?? `qdrant.${baseDomain}`;
  const qdrantDashboardFlag = bool(cfg, "qdrantDashboardEnabled", true);
  const qdrantDashboardAsked = cfg.get("qdrantDashboardEnabled") !== undefined;
  const missingDashboardGate = missingOidcDeps.map((k) => `grid-oib:${k}`).join(", ");
  if (qdrantDashboardFlag && qdrantDashboardAsked && missingOidcDeps.length > 0) {
    throw new Error(
      "grid-oib:qdrantDashboardEnabled needs the platform WorkOS Connect application its route is gated " +
        `by: missing ${missingDashboardGate}. Set them ` +
        "(docs/deployment/kubernetes.md §9), or set qdrantDashboardEnabled=false and port-forward instead.",
    );
  }
  const qdrantDashboardEnabled = qdrantDashboardFlag && missingOidcDeps.length === 0;
  if (qdrantDashboardFlag && !qdrantDashboardEnabled) {
    pulumi.log.warn(
      `Qdrant dashboard not served: missing ${missingDashboardGate}, the WorkOS application its ` +
        "route is gated by. Set them to serve it, or set grid-oib:qdrantDashboardEnabled=false to silence this.",
    );
  }
  return { enabled: qdrantDashboardEnabled, domain: qdrantDashboardDomain };
}
