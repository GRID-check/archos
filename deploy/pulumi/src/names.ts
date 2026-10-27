import * as pulumi from "@pulumi/pulumi";

/**
 * Every infrastructure name the program gives an object, in one table
 * (ADR-0147: infrastructure names carry no brand).
 *
 * The same program runs as two Pulumi projects while the namespace moves:
 * `grid-oib`, the deployment in namespace `grid`, which keeps every name it
 * has until the contract step deletes it, and `workspace`, the deployment that
 * replaces it. A name is picked by the project that is running, so neither
 * stack file says which set it gets and the old stack's preview stays a no-op.
 *
 * Out of this table on purpose, each with its owner (ADR-0147, "The names"):
 * Postgres database and role names (`grid_app`, `grid_keda_scaler`), bucket
 * names and SeaweedFS identities (the bucket follow-up ADR), env var names and
 * OTel service names (the code-identifier rename).
 */
export const LEGACY_PROJECT = "grid-oib";
export const PROJECT = "workspace";

/**
 * Only the `workspace` project gets the brand-free names. Everything else
 * keeps today's: the legacy project, and a module evaluated outside a Pulumi
 * run, where the SDK reports the project as `"project"` (a spec imports its
 * modules before its `setMocks` call runs). The cleanup step after contract
 * folds the table into its second column and deletes this switch.
 */
export function isLegacyProject(project: string = pulumi.getProject()): boolean {
  return project !== PROJECT;
}

/** `[legacy, brand-free]`. The second column is what the `workspace` stack creates. */
const TABLE = {
  namespace: ["grid", "workspace"],
  partOf: ["grid-oib", "workspace"],
  secretChecksumAnnotation: ["grid.bigls.net/secret-checksum", "checksum/secrets"],

  appSecret: ["grid-secrets", "app-secrets"],
  registryPullSecret: ["grid-registry-pull", "registry-pull"],
  kedaScalerSecret: ["grid-keda-scaler", "keda-scaler"],
  rateLimitRedisAuthSecret: ["grid-ratelimit-redis-auth", "ratelimit-redis-auth"],

  pgCluster: ["grid-pg", "postgres"],
  pgPoolerRw: ["grid-pg-pooler-rw", "postgres-pooler-rw"],
  pgBackupSecret: ["grid-pg-backup-s3", "postgres-backup-s3"],
  pgScheduledBackup: ["grid-pg-nightly", "postgres-nightly"],

  gatewayClass: ["eg", "workspace-edge"],
  gateway: ["grid-gateway", "edge"],
  envoyProxy: ["grid-envoy-proxy", "edge-proxy"],
  wsTimeouts: ["grid-ws-timeouts", "ws-timeouts"],

  appRoute: ["grid-app", "app"],
  appTimeouts: ["grid-app-timeouts", "app-timeouts"],
  appTls: ["grid-app-tls", "app-tls"],
  s3Route: ["grid-s3", "s3"],
  s3Timeouts: ["grid-s3-timeouts", "s3-timeouts"],
  s3Tls: ["grid-s3-tls", "s3-tls"],
  webRoute: ["grid-web", "web"],
  webTimeouts: ["grid-web-timeouts", "web-timeouts"],
  webTls: ["grid-web-tls", "web-tls"],
  httpsRedirectRoute: ["grid-https-redirect", "https-redirect"],
  langfuseRoute: ["grid-langfuse", "langfuse"],
  langfuseTls: ["grid-langfuse-tls", "langfuse-tls"],
  langfuseAuth: ["grid-langfuse-auth", "langfuse-auth"],
  qdrantDashboardRoute: ["grid-qdrant-dashboard", "qdrant-dashboard"],
  qdrantDashboardAuth: ["grid-qdrant-dashboard-auth", "qdrant-dashboard-auth"],
  qdrantTls: ["grid-qdrant-tls", "qdrant-tls"],

  migrateJob: ["grid-app-migrate", "app-migrate"],
  auditSchemasJob: ["grid-app-audit-schemas", "app-audit-schemas"],
  authzCatalogJob: ["grid-app-authz-catalog", "app-authz-catalog"],
  folderGrantsJob: ["grid-app-folder-grants", "app-folder-grants"],
  chromaMigrationJob: ["grid-chroma-migration", "chroma-migration"],
} as const satisfies Record<string, readonly [string, string]>;

export type NameKey = keyof typeof TABLE;

/** The name this project gives the object `key`. */
export function objectName(key: NameKey, project?: string): string {
  return TABLE[key][isLegacyProject(project) ? 0 : 1];
}

/** Every brand-free name, for the spec that holds them to the rule. */
export function brandFreeNames(): Record<NameKey, string> {
  return Object.fromEntries(Object.entries(TABLE).map(([k, v]) => [k, v[1]])) as Record<NameKey, string>;
}

/**
 * A Pulumi logical name. These are URN segments, so they stay as they are on
 * the legacy project, where a changed one would replace the resource; the new
 * project's start without the `grid-` prefix.
 */
export function logicalName(legacy: string, project?: string): string {
  return isLegacyProject(project) ? legacy : legacy.replace(/^grid-/, "");
}
