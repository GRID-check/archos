/**
 * PostgreSQL (CloudNativePG): instances, the pooler, credentials and the encrypted PITR archive.
 */
import * as pulumi from "@pulumi/pulumi";
import { createHmac } from "node:crypto";
import { bool, num, positiveInt } from "./readers";

/**
 * Server-side-encryption modes CloudNativePG accepts on `barmanObjectStore`'s
 * `wal.encryption` / `data.encryption`. Mirrors the CRD enum exactly
 * (`Enum=AES256;"aws:kms"`) — "off" is the absence of the key, not `""`, so it
 * has no member here.
 */
export type BarmanEncryption = "AES256" | "aws:kms";

/**
 * The scaler login's password when `pgScalerPassword` is not set: an HMAC of a
 * fixed label under the owner's password. One-way, so holding the scaler DSN
 * says nothing about `pgAppPassword` (Postgres authenticates by role AND
 * password, which is the whole reason `app_rw` has a password of its own),
 * and URL-safe, so it needs no care in a DSN. It follows `pgAppPassword` when
 * that rotates.
 */
function derivedScalerPassword(appPassword: pulumi.Output<string>): pulumi.Output<string> {
  return pulumi.secret(
    appPassword.apply((password) => createHmac("sha256", password).update("grid-keda-scaler").digest("base64url")),
  );
}

export interface PostgresConfig {
  /** CloudNativePG instance count (1 = single primary; ≥2 = HA with replicas). */
  instances: number;
  /**
   * The transaction pooler in front of the pooled DSNs (ADR-0083). Its worst
   * case against `max_connections` is `pgConnectionBudget`, and the plan fails
   * when that does not fit.
   */
  pooler: {
    /** PgBouncer replicas (`pgPoolerInstances`). Each keeps its own server pool per (database, role). */
    instances: number;
    /**
     * Server connections one PgBouncer opens per (database, role) pair
     * (`pgPoolerPoolSize`, PgBouncer's `default_pool_size`). The default is 12,
     * the largest that lets a fresh stack with everything on pass the plan:
     * two poolers x (three pooled pairs x 12 + 1 auth session) = 74 of the
     * primary's 200 connections, against a direct reserve of up to 122 (62
     * fixed or sized by the ingest tier at 5 x 3, 20 for Langfuse, 40 for a
     * filer that keeps its namespace in Postgres) = 196. Prod, on the single
     * SeaweedFS topology and an ingest tier of 3 x 3, holds 74 + 76 = 150.
     * It is not a demand number: a transaction holds a server connection for milliseconds, and 24 per pair
     * across the two poolers serves hundreds of statements a second. Clients
     * past the pool queue in PgBouncer, which shows as `cl_waiting` rather than
     * as an error. Raise it only together with `max_connections`.
     */
    poolSize: number;
    /** Digest-pinned PgBouncer image (>= 1.21: protocol-level prepared statements). */
    image: string;
  };
  storageSize: string;
  /** App role name that owns the three databases. */
  appUser: string;
  /** App role password. Secret. Drives every DSN. */
  appPassword: pulumi.Output<string>;
  /**
   * Password for `app_rw`, the least-privilege role the app tier
   * connects as under row-level security (ADR-0041). REQUIRED, and
   * deliberately without a fallback to `pgAppPassword`.
   *
   * It used to default to the app password, on the reasoning that what bounds
   * this role is its PRIVILEGES — DML only, RLS enforced, no DDL — rather than
   * password distinctness. That reasoning is wrong: Postgres authenticates by
   * (role, password), so anyone holding the runtime DSN could present the same
   * password as `appUser`, the schema owner, who is exempt from every policy.
   * The privilege split is only worth what the credential split is worth.
   *
   * `pulumi config set --secret pgRuntimePassword <value>` on each stack; an
   * existing stack must set it (and rotate) before the next deploy.
   */
  runtimePassword: pulumi.Output<string>;
  /**
   * Password for `keda_scaler`, the read-only login KEDA's `postgresql`
   * scaler counts the queue tables with (ADR-0079). Optional
   * (`pgScalerPassword`): unset, it is derived from `pgAppPassword` by a
   * one-way HMAC, so it is never the owner's password and an existing stack
   * needs no new secret to deploy. Set it to rotate the scaler's credential
   * on its own.
   */
  scalerPassword: pulumi.Output<string>;
  /**
   * How CNPG rolls the primary during an operator/image update.
   * "unsupervised" = automatic switchover + restart (no human), which is what
   * you want on a provider that drains/replaces nodes automatically.
   */
  primaryUpdateStrategy: "unsupervised" | "supervised";
  /**
   * Continuous WAL archiving + scheduled base backups to SeaweedFS via CNPG's
   * Barman object-store integration — the only real defence against the
   * provider's `Delete` reclaim policy (a dropped PVC is otherwise
   * unrecoverable). Gives point-in-time recovery.
   */
  backups: {
    enabled: boolean;
    /**
     * S3 endpoint Barman writes to. Default: the in-cluster SeaweedFS —
     * which protects against Postgres PVC loss but NOT against cluster
     * deletion (it lives on the same Delete-reclaim CSI). Point this at an
     * external S3 (with matching bucket + credentials via
     * pgBackupAccessKey/pgBackupSecretKey) for real offsite PITR.
     */
    endpoint: string;
    /** Override credentials for an external endpoint (default: SeaweedFS's). */
    accessKey?: string;
    secretKey?: pulumi.Output<string>;
    /** Bucket for base backups + WAL (auto-created only on in-cluster SeaweedFS). */
    bucket: string;
    /** Barman retention (e.g. "30d"). */
    retention: string;
    /** 6-field cron (CNPG uses seconds-first): default nightly 02:00. */
    schedule: string;
    /**
     * **Server-side** encryption barman-cloud asks the destination for, on
     * both the WAL stream and the base backups. Undefined (the default) means
     * the key is omitted entirely and the bucket's own policy decides — which,
     * on a bucket with no policy, means the archive is written in the clear.
     *
     * This matters more than any other encryption knob in the program: the
     * PITR archive is a byte-for-byte copy of every database — every
     * conversation, every LangGraph checkpoint, every WAL record — sitting in
     * object storage.
     *
     * The accepted values are CloudNativePG's, not ours. The field lives on
     * `wal` and `data` inside `barmanObjectStore` (NOT at its top level) and
     * the CRD pins it to an enum:
     *
     *   `+kubebuilder:validation:Enum=AES256;"aws:kms"`
     *   "Whenever to force the encryption of files (if the bucket is not
     *    already configured for that). Allowed options are empty string (use
     *    the bucket policy, default), `AES256` and `aws:kms`."
     *   — barman-cloud `pkg/api`, {Wal,Data}BackupConfiguration.Encryption
     *
     * Because the enum has no empty member, an explicit `encryption: ""` is
     * REJECTED by the webhook; "off" must be the key being absent, which is
     * why this is `undefined` rather than `""`.
     *
     * **SSE only encrypts if the DESTINATION implements it.** barman-cloud
     * turns this into an `x-amz-server-side-encryption` header; a store that
     * does not implement SSE answers 200 and writes plaintext. The default
     * destination here is the in-cluster SeaweedFS, which has NO SSE at all on
     * the pinned 3.80 image (SSE-S3/KMS/C first appear in 3.97, and this
     * program configures no KMS for them even on a newer image). Setting this
     * against that endpoint would be a setting that reads as encryption and
     * is not — so `loadConfig` REFUSES the combination outright rather than
     * letting it ship. Use it with an external S3 destination
     * (`pgBackupEndpoint` + `pgBackupAccessKey`/`pgBackupSecretKey`) that
     * documents SSE support.
     */
    encryption?: BarmanEncryption;
  };
}

export function loadPostgres(cfg: pulumi.Config): PostgresConfig {
  // ── Postgres PITR archive encryption ──────────────────────────────────────
  // The archive is the single largest plaintext surface in the stack when it is
  // on: WAL + base backups are a byte-for-byte copy of all three databases.
  // `pgBackupEncryption` asks the DESTINATION for server-side encryption, so it
  // is only ever as real as the destination — hence the two checks below and
  // the warning that names the exposure when there is none.
  const pgBackupsEnabled = bool(cfg, "pgBackupsEnabled", false);
  const pgBackupEndpoint = cfg.get("pgBackupEndpoint") ?? "http://seaweedfs:8333";
  const pgBackupEncryptionRaw = (cfg.get("pgBackupEncryption") ?? "").trim();
  const pgBackupEncryption: BarmanEncryption | undefined =
    pgBackupEncryptionRaw === "" ? undefined : (pgBackupEncryptionRaw as BarmanEncryption);
  if (pgBackupEncryption !== undefined && !["AES256", "aws:kms"].includes(pgBackupEncryption)) {
    // The CNPG webhook would reject this too, but only ~20 min into a `pulumi
    // up` that has already started mutating the cluster.
    throw new Error(
      `grid-oib:pgBackupEncryption must be "AES256" or "aws:kms" (got "${pgBackupEncryptionRaw}"). ` +
        "Leave it unset to inherit the bucket policy — CloudNativePG's enum has no empty member, " +
        "so \"off\" is the key being absent, not an empty string.",
    );
  }
  // `//seaweedfs` also catches `http://seaweedfs.grid.svc.cluster.local:8333`.
  const pgBackupIsInCluster =
    pgBackupEndpoint.includes("//seaweedfs") || pgBackupEndpoint.includes("seaweedfs:8333");
  if (pgBackupEncryption !== undefined && pgBackupIsInCluster) {
    // Refuse rather than warn. barman-cloud turns this into an
    // `x-amz-server-side-encryption` request header; SeaweedFS 3.80 (the pinned
    // production image) implements no SSE at all, answers 200, and stores the
    // object unencrypted. Accepting the setting here would put "encryption:
    // AES256" in the Cluster spec, in the plan, and in any audit of it — while
    // the bytes on disk are plaintext. That is worse than no setting.
    throw new Error(
      `grid-oib:pgBackupEncryption is set ("${pgBackupEncryptionRaw}") but pgBackupEndpoint points at ` +
        `the in-cluster SeaweedFS (${pgBackupEndpoint}), which implements no server-side encryption ` +
        "(SSE-S3/KMS/C first appear in 3.97; prod pins 3.80, and this program configures no KMS for " +
        "them on any image). SeaweedFS answers such a request 200 and stores the object in the clear, " +
        "so the setting would claim an encryption that does not exist. Point pgBackupEndpoint at an " +
        "external S3 destination that documents SSE support, or leave pgBackupEncryption unset.",
    );
  }
  if (pgBackupsEnabled && pgBackupEncryption === undefined) {
    pulumi.log.warn(
      "Postgres PITR archive is UNENCRYPTED at rest. WAL and base backups are a byte-for-byte copy " +
        "of all three databases (conversations, LangGraph checkpoints, the whole app schema) " +
        `and go to ${pgBackupEndpoint} with no encryption requested. On the in-cluster SeaweedFS ` +
        "there is no fix available in this program — SeaweedFS 3.80 has no SSE, and volume-chunk " +
        "encryption (seaweedfsEncryptVolumeData) is the only at-rest control that applies. For a " +
        "real guarantee use an external S3 destination and set grid-oib:pgBackupEncryption=AES256. " +
        "See docs/deployment/kubernetes.md § Encryption posture.",
    );
  }
      return {
    instances: num(cfg, "pgInstances", 1),
    pooler: {
      instances: positiveInt(cfg, "pgPoolerInstances", 2),
      poolSize: positiveInt(cfg, "pgPoolerPoolSize", 12),
      // Digest-pinned like the ADR-0029 and ADR-0044 images, and scanned by the
      // same trivy job in security.yml. The tag is the version (1.26.0, which
      // is >= 1.21: protocol-level prepared statements in transaction mode);
      // the digest is what the cluster pulls. CloudNativePG's own build of
      // PgBouncer, because the operator drives its config and its auth query.
      image:
        cfg.get("pgPoolerImage") ??
        "ghcr.io/cloudnative-pg/pgbouncer:1.26.0@sha256:ce54f1133c509f1db8a8092c3f1c761d8c9292065ed6b6698786bb966da4dab9",
    },
    storageSize: cfg.get("pgStorageSize") ?? "20Gi",
    appUser: cfg.get("pgAppUser") ?? "agent",
    appPassword: cfg.requireSecret("pgAppPassword"),
    runtimePassword: cfg.requireSecret("pgRuntimePassword"),
    scalerPassword: cfg.getSecret("pgScalerPassword") ?? derivedScalerPassword(cfg.requireSecret("pgAppPassword")),
    primaryUpdateStrategy:
      cfg.get("pgPrimaryUpdateStrategy") === "supervised" ? "supervised" : "unsupervised",
    backups: {
      enabled: pgBackupsEnabled,
      endpoint: pgBackupEndpoint,
      accessKey: cfg.get("pgBackupAccessKey"),
      secretKey: cfg.getSecret("pgBackupSecretKey"),
      bucket: cfg.get("pgBackupBucket") ?? "grid-pg-backups",
      retention: cfg.get("pgBackupRetention") ?? "30d",
      schedule: cfg.get("pgBackupSchedule") ?? "0 0 2 * * *",
      encryption: pgBackupEncryption,
    },
  };
}
