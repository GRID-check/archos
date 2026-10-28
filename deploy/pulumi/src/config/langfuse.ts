/**
 * Langfuse (ADR-0044): available when the flag and the capability both say so, with every key it validates itself checked here first.
 */
import * as pulumi from "@pulumi/pulumi";
import { bool } from "./readers";

/** The roles Langfuse accepts for `LANGFUSE_DEFAULT_ORG_ROLE` (its `env.mjs` enum). */
export const LANGFUSE_ORG_ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER", "NONE"] as const;

export type LangfuseOrgRole = (typeof LANGFUSE_ORG_ROLES)[number];

/**
 * `langfuseDefaultRole`, refused at load time when Langfuse would refuse it.
 * Langfuse validates the variable with a zod enum at startup, so a typo there
 * is not a fallback to VIEWER but a langfuse-web that never becomes Ready.
 */
function langfuseOrgRole(value: string | undefined): LangfuseOrgRole {
  if (value === undefined || value.trim() === "") return "VIEWER";
  const role = LANGFUSE_ORG_ROLES.find((known) => known === value.trim());
  if (role) return role;
  throw new Error(`langfuseDefaultRole must be one of ${LANGFUSE_ORG_ROLES.join(", ")}, not "${value}"`);
}

/**
 * `langfuseV4WriteMode` is gone: Langfuse writes v4's events table only
 * (kubernetes.md §9b). A stack that still sets it is refused rather than
 * silently ignored, so nobody believes they kept the v3 tables.
 */
export function refuseLangfuseV4WriteMode(value: string | undefined): void {
  if (value === undefined) return;
  throw new Error(
    `langfuseV4WriteMode was removed: Langfuse writes v4 events only. Drop "${value}" with \`pulumi config rm grid-oib:langfuseV4WriteMode\`.`,
  );
}

export interface LangfuseConfig {
  /**
   * Whether the tier is deployed: the `langfuseEnabled` flag AND the
   * capability derived from its dependencies (every credential it cannot
   * boot without, the Connect application it signs in against, plus the
   * `observabilityEnabled` flag — it is fed by the collector, so without one
   * it is four workloads that can only ever sit idle).
   */
  enabled: boolean;
  /** Public hostname. Derived: `langfuse.<baseDomain>` unless overridden. */
  domain: string;
  /** Langfuse web image (UI + public API + OTLP receiver), digest-pinned. */
  webImage: string;
  /**
   * Langfuse worker image. A SEPARATE knob rather than a shared tag because
   * upstream publishes them as two images; they must nonetheless be the same
   * VERSION — `loadConfig` cannot check that (digests are opaque), so it is
   * on the operator, and `docs/deployment/kubernetes.md` says so.
   */
  workerImage: string;
  /** ClickHouse server image, digest-pinned. */
  clickhouseImage: string;
  /**
   * Rewrite historic traces into v4's tables in the background
   * (`LANGFUSE_BACKGROUND_MIGRATION_V4_ENABLE_HISTORIC_BACKFILL`). Off by
   * default: upstream asks for about three times the current ClickHouse disk
   * as headroom, which the 50 Gi PVC is not sized for.
   */
  v4HistoricBackfill: boolean;
  /**
   * PVC for ClickHouse. The TRACE store is still the tier's unbounded
   * resource: retention policies are an Enterprise feature, so observations
   * grow for as long as the deployment runs - size for the history you
   * intend to keep by hand, and watch it. The SERVER's own system logs are
   * the exception: `installClickHouse` gives them a 14-day TTL, so they can
   * no longer fill the disk the way `system.trace_log` did on dev in August
   * 2026. The 50 Gi default covers both with headroom.
   */
  clickhouseStorageSize: string;
  /** Ingestion-queue dataset cap and pod memory limit (see `LANGFUSE.queue`). */
  queueMaxmemory: string;
  queueMemoryLimit: string;
  /**
   * `requirepass` for the ingestion queue. Its OWN credential, distinct from
   * both `dragonflyPassword` and `rateLimitStorePassword` for the reason
   * given on those two: shared key material makes every holder of one
   * instance's URL an administrator of the others.
   */
  queuePassword: pulumi.Output<string>;
  /** Login for the dedicated Postgres role that owns the Langfuse database. */
  databasePassword: pulumi.Output<string>;
  /** ClickHouse login password. */
  clickhousePassword: pulumi.Output<string>;
  /**
   * `SALT` — hashes the API keys Langfuse stores. Changing it invalidates
   * every existing key, including the ingestion key the collector holds.
   */
  salt: pulumi.Output<string>;
  /**
   * `ENCRYPTION_KEY` — 256-bit key, **64 hex characters**, encrypting the
   * secrets Langfuse stores at rest (LLM API keys for the playground,
   * integration credentials). `loadConfig` checks the shape, because
   * Langfuse's own failure for a malformed value is a crash loop at startup
   * with a stack trace, not a message naming the variable.
   */
  encryptionKey: pulumi.Output<string>;
  /** `NEXTAUTH_SECRET` — signs the Langfuse session cookie. */
  nextAuthSecret: pulumi.Output<string>;
  /**
   * The project's ingestion API keys, pre-seeded via headless
   * initialization (`LANGFUSE_INIT_PROJECT_*`).
   *
   * This is what makes the tier deployable in one `pulumi up` rather than
   * two: the collector needs an ingestion credential in the same apply that
   * creates Langfuse, and the alternative — boot Langfuse, log in, mint a
   * key by hand, put it in the stack config, apply again — is a bootstrap
   * that cannot be automated and quietly rots.
   *
   * Langfuse validates the prefixes, so `publicKey` must start `pk-lf-` and
   * `secretKey` must start `sk-lf-`; `loadConfig` checks both rather than
   * letting the web container reject them on startup.
   */
  publicKey: pulumi.Output<string>;
  secretKey: pulumi.Output<string>;
  /** Headless-init identifiers. Stable strings, not secrets. */
  orgId: string;
  projectId: string;
  /**
   * The role a NEW Langfuse user gets in the seeded org (`orgId`) and project
   * (`projectId`) on their first sign-in (`LANGFUSE_DEFAULT_ORG_ROLE` /
   * `LANGFUSE_DEFAULT_PROJECT_ROLE`, upstream's automated access
   * provisioning). Default `VIEWER`: read-only. Without a default, a first SSO
   * login lands in no organization at all and sees nothing, and the people
   * the edge now admits for read-only analysis (`platform:observability:view`)
   * would each need an owner to add them by hand before they saw a trace.
   *
   * Applies only when the Langfuse account is CREATED (or first linked to the
   * SSO identity); an existing membership is never changed by it, so
   * promotion to MEMBER or ADMIN is an owner's edit in the Langfuse UI and
   * survives every deploy. `NONE` joins the org with no access and no
   * project, which is "an owner grants each person by hand". OSS Langfuse has
   * no project-level roles (an Enterprise entitlement), so the ORG role is the
   * one that decides; the project role is set to match for when it does.
   */
  defaultRole: LangfuseOrgRole;
  /**
   * The break-glass Langfuse account created at headless init.
   *
   * Sign-in normally happens through WorkOS SSO (`AUTH_CUSTOM_*`), so this
   * exists for the case SSO itself is what is broken. It is a real password
   * on a real account behind the edge permission gate — treat it as a
   * credential, not a placeholder.
   */
  initUserEmail: string;
  initUserPassword: pulumi.Output<string>;
  /**
   * S3 identity for the Langfuse bucket. The secret key MUST differ from
   * every other SeaweedFS credential in the deployment, for the reason
   * `backendReadSecretKey` gives: shared key material would let this tier
   * authenticate as an identity with a wider bucket scope.
   */
  s3AccessKey: string;
  s3SecretKey: pulumi.Output<string>;
}

export function loadLangfuse(
  cfg: pulumi.Config,
  baseDomain: string,
  missingOidcDeps: string[],
  observabilityFlag: boolean,
): LangfuseConfig {
  // ── Langfuse (ADR-0044): same availability = flag AND capability rule ──────
  // Default ON, like `observabilityEnabled`: durable traces are the expected
  // shape of a stack now, not an extra. Nothing is provisioned by the flag
  // alone — the capability half of the rule still requires every credential the
  // tier cannot boot without, so a stack that has not set them gets the warning
  // below and no workloads, never a half-deployed tier. Set the flag to false
  // to opt out of the four workloads and the PVC that grows without a
  // retention policy. The dependency on `observabilityEnabled` is structural:
  // Langfuse has no receiver of its own in this design, the collector fans
  // traces into it, so without it it is idle.
  //
  // It signs in against the platform WorkOS Connect application rather than
  // asking for a fourth OIDC triple. One application can carry several redirect
  // URIs, and the alternative is an operator provisioning two near-identical
  // confidential clients that gate on the same permission — two places to get
  // the scope assignment wrong, for no separation that anyone would use.
  const langfuseDomain = cfg.get("langfuseDomain") ?? `langfuse.${baseDomain}`;
  const langfuseFlag = bool(cfg, "langfuseEnabled", true);
  const langfuseEncryptionKey = cfg.getSecret("langfuseEncryptionKey");
  const langfusePublicKey = cfg.getSecret("langfusePublicKey");
  const langfuseSecretKey = cfg.getSecret("langfuseSecretKey");
  const langfuseSecretKeys = [
    "langfuseSalt",
    "langfuseEncryptionKey",
    "langfuseNextAuthSecret",
    "langfusePublicKey",
    "langfuseSecretKey",
    "langfuseDbPassword",
    "langfuseClickhousePassword",
    "langfuseQueuePassword",
    "langfuseS3SecretKey",
    "langfuseInitUserPassword",
  ];
  const missingLangfuseDeps = [
    ...langfuseSecretKeys.filter((key) => (cfg.get(key) ?? "").trim() === ""),
    ...missingOidcDeps,
    observabilityFlag ? undefined : "observabilityEnabled (Langfuse is fed by the collector)",
  ].filter((k): k is string => k !== undefined);
  const langfuseEnabled = langfuseFlag && missingLangfuseDeps.length === 0;
  if (langfuseFlag && !langfuseEnabled) {
    pulumi.log.warn(
      "Langfuse (ADR-0044) not deployed: missing " +
        missingLangfuseDeps.map((k) => (k.includes(" ") ? k : `grid-oib:${k}`)).join(", ") +
        ". Set them to deploy the durable trace store, or set " +
        "grid-oib:langfuseEnabled=false to silence this.",
    );
  }
  // Shape checks, run only when the tier is actually being deployed so that a
  // stack which has not adopted it is never failed by a key it does not set.
  //
  // Every one of these is a value Langfuse validates ITSELF — the point is
  // WHERE the failure lands. Rejected at startup they are a CrashLoopBackOff on
  // a container whose logs an operator has to go find; rejected here they are a
  // line of `pulumi preview` naming the key.
  if (langfuseEnabled) {
    // 32 bytes, hex — `openssl rand -hex 32`. A base64 value (the format every
    // OTHER secret in this program uses) is the overwhelmingly likely mistake,
    // and it is 44 characters, so length alone catches it.
    const encryptionKeyRaw = (cfg.get("langfuseEncryptionKey") ?? "").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyRaw)) {
      throw new Error(
        "grid-oib:langfuseEncryptionKey must be exactly 64 hex characters (a 256-bit key). " +
          `Got ${encryptionKeyRaw.length} character(s). Note this is the ONE secret here that is ` +
          "hex rather than base64 — generate it with `openssl rand -hex 32`, not `openssl rand -base64 32`.",
      );
    }
    const keyPrefixes: Array<[string, string]> = [
      ["langfusePublicKey", "pk-lf-"],
      ["langfuseSecretKey", "sk-lf-"],
    ];
    for (const [key, prefix] of keyPrefixes) {
      const value = (cfg.get(key) ?? "").trim();
      if (!value.startsWith(prefix)) {
        throw new Error(
          `grid-oib:${key} must start with "${prefix}" — Langfuse validates the prefix on the ` +
            "keys it seeds at headless initialization and refuses to start otherwise. Generate " +
            `one with \`echo "${prefix}$(openssl rand -hex 16)"\`.`,
        );
      }
    }
    // The ClickHouse password must be URL-SAFE, and this is the guard that
    // stops the tier's own documented setup from breaking itself.
    //
    // Langfuse's ClickHouse migrator builds its connection string by raw shell
    // interpolation — `packages/shared/clickhouse/scripts/up.sh`:
    //
    //     DATABASE_URL="${CLICKHOUSE_MIGRATION_URL}?username=${CLICKHOUSE_USER}
    //       &password=${CLICKHOUSE_PASSWORD}&database=${CLICKHOUSE_DB}&..."
    //
    // Nothing percent-encodes that value. Every other secret in this program is
    // generated with `openssl rand -base64 32`, which for 32 bytes ALWAYS ends
    // in `=` and frequently contains `+` — so following the house convention
    // here produces a password that truncates or corrupts the query string. The
    // result is a langfuse-web container that fails the ClickHouse migration
    // and exits: CrashLoopBackOff, with nothing in the logs but a generic HINT
    // about special characters. Upstream only warns; this refuses.
    //
    // Unreserved characters (RFC 3986 §2.3) rather than a blocklist of what
    // breaks today: a blocklist has to be right about every future
    // interpolation site, and this value crosses a shell, a query string and a
    // Go URL parser before it reaches ClickHouse.
    const clickhousePasswordRaw = (cfg.get("langfuseClickhousePassword") ?? "").trim();
    if (!/^[A-Za-z0-9._~-]+$/.test(clickhousePasswordRaw)) {
      throw new Error(
        "grid-oib:langfuseClickhousePassword must contain only URL-safe characters " +
          "(A-Z a-z 0-9 . _ ~ -). Langfuse's ClickHouse migrator interpolates it into a " +
          "connection-string query parameter without encoding it, so `+`, `=`, `/` or `&` — " +
          "all of which `openssl rand -base64 32` produces — break the migration and " +
          "crash-loop langfuse-web. Generate this one with `openssl rand -hex 32` instead.",
      );
    }

    // Fail closed: this tier needs NetworkPolicies — the trace store, its
    // ClickHouse and its ingestion queue all sit in the app namespace holding
    // every tenant's prompts and LLM output, and the policy set is what keeps
    // the rest of the namespace off them. (The Aspire dashboard's identical
    // guard went with the dashboard.)
    if (!bool(cfg, "networkPolicies", true)) {
      throw new Error(
        "grid-oib:langfuseEnabled requires grid-oib:networkPolicies. Langfuse, its ClickHouse " +
          "and its queue hold every tenant's prompts and LLM output in the app namespace, and " +
          "the NetworkPolicy set is what keeps the rest of the namespace off them. Set " +
          "networkPolicies=true, or langfuseEnabled=false.",
      );
    }
    //
    // Distinctness, not strength — the same control as pgRuntimePassword and
    // rateLimitStorePassword. Every app pod already holds the ADR-0020 cache
    // URL; if the Langfuse queue shared that password, anything that reads one
    // app pod's env could drain the ingestion queue.
    const queuePasswordRaw = (cfg.get("langfuseQueuePassword") ?? "").trim();
    const collides = [
      ["dragonflyPassword", cfg.get("dragonflyPassword")],
      ["rateLimitStorePassword", cfg.get("rateLimitStorePassword")],
    ].find(([, other]) => (other ?? "").trim() === queuePasswordRaw);
    if (collides) {
      throw new Error(
        `grid-oib:langfuseQueuePassword must differ from grid-oib:${collides[0]}. They are ` +
          "separate Redis-protocol instances precisely so that holding one credential does not " +
          "confer control of the others; an identical value silently removes that separation.",
      );
    }
    // The S3 identity is scoped to the Langfuse bucket alone. Reusing another
    // identity's secret key hands this tier that identity's scope instead —
    // which for `seaweedfsSecretKey` is object CRUD across every tenant bucket.
    const langfuseS3SecretRaw = (cfg.get("langfuseS3SecretKey") ?? "").trim();
    const s3Collides = [
      ["seaweedfsSecretKey", cfg.get("seaweedfsSecretKey")],
      ["seaweedfsBackendReadSecretKey", cfg.get("seaweedfsBackendReadSecretKey")],
      ["seaweedfsTenantAdminSecretKey", cfg.get("seaweedfsTenantAdminSecretKey")],
    ].find(([, other]) => (other ?? "").trim() === langfuseS3SecretRaw);
    if (s3Collides) {
      throw new Error(
        `grid-oib:langfuseS3SecretKey must differ from grid-oib:${s3Collides[0]}. SeaweedFS ` +
          "authenticates by key, so a shared secret gives the Langfuse tier that identity's " +
          "bucket scope instead of its own single-bucket one.",
      );
    }
  }
      return {
    enabled: langfuseEnabled,
    domain: langfuseDomain,
    // Digest-pinned on the same terms as the ADR-0029 images, and scanned by
    // the same trivy gate: langfuse 4.71.0 (web + worker, which MUST be the
    // same version) and ClickHouse 26.8.33.10 LTS, which v4 needs (>= 25.12).
    // The langfuse digests are what GHCR's `4.71.0` tags resolve to (multi-arch
    // index, read anonymously from the registry on 2026-10-27); `26.8` is a moving tag upstream and this is the digest
    // it resolved to when pinned (2026-10-22, 26.8.33.10; moved within the
    // 26.8 line off 26.8.15.10, whose Ubuntu 22.04 base had OpenSSL
    // 3.0.2-0ubuntu1.29, CVE-2026-84782; 26.8.33.10 carries 0ubuntu1.30, read
    // from its dpkg database by a local trivy scan, and the same entrypoint,
    // ports and TZ=UTC). Langfuse moved off 4.63.0 because both images
    // bundled @modelcontextprotocol/sdk 1.31.0 (CVE-2026-111767, -111768) and
    // follow-redirects 1.16.0 (CVE-2026-111755, -111756), and the web image's
    // `usr/bin/migrate` was built with go1.26.9 (CVE-2026-111943). 4.64.0
    // through 4.67.0 still carry all of them; 4.68.0 ships sdk 1.32.0,
    // follow-redirects 1.16.1 and a go1.26.10 migrate, read from the images'
    // package manifests and build info by a local trivy scan, not from
    // release notes. 4.68.0 also turns on project API key permissions by
    // default (API_AUTH_MIGRATION=enforce); keys without a role assignment are
    // backfilled with their legacy role on first use. It moved 4.68.0 -> 4.71.0
    // on 2026-10-27 because the 4.68.0 images failed the promotion's trivy
    // gate: ca-certificates on the UBI 9 base (CVE-2026-114406, CRITICAL),
    // body-parser 2.3.0 (CVE-2026-111181) and @sentry/nextjs 10.64.0
    // (CVE-2026-114139). 4.56.0 moved both images
    // off node:24-alpine onto UBI 9 micro; the uid (1001), entrypoints and
    // commands are unchanged since. v3 (3.225.11) shipped next 16.2.11, whose
    // next/og RCE (GHSA-vcvr-r3jv-pc5j) no 3.x release fixes.
    webImage:
      cfg.get("langfuseWebImage") ??
      "ghcr.io/langfuse/langfuse@sha256:1e600bc28c40fa0c028b9ed313e51d421132fe423ba84986fb9242fc40b7cd42",
    workerImage:
      cfg.get("langfuseWorkerImage") ??
      "ghcr.io/langfuse/langfuse-worker@sha256:8e7cfec29f6322a8aff64e8ff4f9194c5c8181d4286514be0e3727b199605949",
    clickhouseImage:
      cfg.get("clickhouseImage") ??
      "clickhouse/clickhouse-server@sha256:1c0b76ac42e16b4eeb0be84013c67269b660701971d29bab9ad0d01b0ba6c10d",
    v4HistoricBackfill: bool(cfg, "langfuseV4HistoricBackfill", false),
    // 50 Gi: fourteen days of TTL-bounded system logs plus headroom for the
    // trace store itself, which still grows without bound (OSS has no
    // retention policies) - see the interface comment. Raised from 20 Gi
    // after system.trace_log alone filled that on dev in August 2026.
    clickhouseStorageSize: cfg.get("clickhouseStorageSize") ?? "50Gi",
    // The queue holds references to events already durable in S3, not the
    // events themselves, so it stays small — but eviction is OFF (see
    // `installLangfuseQueue`), which means "small" has to mean "big enough".
    queueMaxmemory: cfg.get("langfuseQueueMaxmemory") ?? "512mb",
    queueMemoryLimit: cfg.get("langfuseQueueMemoryLimit") ?? "1Gi",
    queuePassword: cfg.getSecret("langfuseQueuePassword") ?? pulumi.output(""),
    databasePassword: cfg.getSecret("langfuseDbPassword") ?? pulumi.output(""),
    clickhousePassword: cfg.getSecret("langfuseClickhousePassword") ?? pulumi.output(""),
    salt: cfg.getSecret("langfuseSalt") ?? pulumi.output(""),
    encryptionKey: langfuseEncryptionKey ?? pulumi.output(""),
    nextAuthSecret: cfg.getSecret("langfuseNextAuthSecret") ?? pulumi.output(""),
    publicKey: langfusePublicKey ?? pulumi.output(""),
    secretKey: langfuseSecretKey ?? pulumi.output(""),
    // Stable identifiers, not secrets, and deliberately not derived from the
    // domain: headless init matches on them, so a value that moves when the
    // hostname moves would create a SECOND org/project rather than reuse the
    // existing one, orphaning every trace already stored.
    orgId: cfg.get("langfuseOrgId") ?? "grid",
    projectId: cfg.get("langfuseProjectId") ?? "grid-oib",
    defaultRole: langfuseOrgRole(cfg.get("langfuseDefaultRole")),
    initUserEmail: cfg.get("langfuseInitUserEmail") ?? cfg.get("letsEncryptEmail") ?? "",
    initUserPassword: cfg.getSecret("langfuseInitUserPassword") ?? pulumi.output(""),
    s3AccessKey: cfg.get("langfuseS3AccessKey") ?? "grid-langfuse",
    s3SecretKey: cfg.getSecret("langfuseS3SecretKey") ?? pulumi.output(""),
  };
}
