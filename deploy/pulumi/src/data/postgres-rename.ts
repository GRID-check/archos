import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { DeployConfig } from "../config";
import { BOOTSTRAP_JOB_RESOURCES, JOB_DEFAULTS, KEDA_SCALER_CONNECTION_LIMIT, PORT } from "../constants";
import { commonLabels } from "../platform/namespaces";
import { secretChecksum, secretChecksumAnnotations } from "../platform/rollout";
import { onNodeGroup } from "../platform/scheduling";
import { hardenedJobSecurityContext } from "../platform/security";

/**
 * The application databases. Before ADR-0145 (row 10d) they were `aiq_jobs`,
 * `aiq_checkpoints` and `grid_app`.
 */
export const JOBS_DB = "jobs";
export const CHECKPOINTS_DB = "checkpoints";
export const APP_DB = "app";

/**
 * The row-level-security roles (ADR-0041). Before ADR-0145 (row 10d) they were
 * `grid_app_rw`, `grid_app_platform`, `grid_app_owner` and `grid_keda_scaler`,
 * and a fresh cluster still creates them under those names: the migrations
 * written before the rename grant to them by name. The after-migrate Job below
 * renames them.
 */
export const RUNTIME_ROLE = "app_rw";

/** The script that renames the databases and the roles, shared with Compose's `postgres-rename` services. */
export const RENAME_SCRIPT = resolve(__dirname, "../../../postgres/rename-legacy-names.sh");

/** What both Jobs need from the cluster: where it is, and the Secrets they read. */
export interface PostgresRenameWiring {
  rwHost: string;
  superuserSecret: string;
  appSecret: pulumi.Input<string>;
  runtimeSecret: pulumi.Input<string>;
  scalerSecret: pulumi.Input<string>;
  /** The two passwords the script sets, so a rotation re-runs the Job (`secretChecksum`). */
  passwords: Record<string, pulumi.Input<string>>;
}

/**
 * The Job that renames `aiq_jobs`, `aiq_checkpoints`, `grid_app` and the role
 * `aiq` to their names without a brand (`deploy/postgres/rename-legacy-names.sh`),
 * on every deploy before anything connects with the new names: the init Job and
 * the migrations wait on it, and every tier on those. The second run, and a
 * fresh cluster bootstrapped with the new names, change nothing.
 *
 * It also keeps the row-level-security roles in being (`ENSURE_RLS_ROLES`) and
 * sets the runtime and scaler passwords from their Secrets. Those roles used to
 * be the Cluster's `managed.roles`, but the operator creates a role it is told
 * about by name: told the new names, it would make empty roles beside the old
 * ones before the rename ran; told to drop the old ones, it would drop the roles
 * a fresh cluster migrates with.
 *
 * It logs in as CloudNativePG's `postgres` superuser (`enableSuperuserAccess`
 * on the Cluster, its Secret `<cluster>-superuser`): a database can only be
 * renamed by a superuser or by its owner holding CREATEDB, and a role never by
 * itself, and the agent role has neither. A rename refuses new sessions to the
 * old database and ends the open ones, so the deploy that carries it is a short
 * outage for the backend tiers, which the release note says. The operator sets
 * the renamed role's password from the app Secret itself; the script sets it
 * too, because a rename clears an MD5 hash.
 */
export function installPostgresRename(
  cfg: DeployConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  wiring: PostgresRenameWiring,
  dependsOn: pulumi.Resource[],
): { job: k8s.batch.v1.Job; script: k8s.core.v1.ConfigMap } {
  const labels = commonLabels("pg-rename");
  const script = new k8s.core.v1.ConfigMap(
    "pg-rename-script",
    { metadata: { namespace, labels }, data: { "rename-legacy-names.sh": readFileSync(RENAME_SCRIPT, "utf8") } },
    // The Jobs run again when the script changes.
    { provider, replaceOnChanges: ["data"] },
  );
  const job = renameJob(cfg, provider, namespace, wiring, {
    name: "pg-rename-legacy-names",
    script,
    args: [],
    env: [{ name: "ENSURE_RLS_ROLES", value: "1" }],
    dependsOn,
  });
  return { job, script };
}

/**
 * The Job that renames the row-level-security roles once the migrations have
 * run (`rename-legacy-names.sh after-migrate`): `grid_app_rw` → `app_rw`,
 * `grid_app_platform` → `app_platform`, `grid_app_owner` → `app_owner`,
 * `grid_keda_scaler` → `keda_scaler`. Every tier that logs in as one of them
 * waits on it. The migrations run as the database owner (`agent`), which these
 * renames do not touch.
 */
export function installRlsRoleRename(
  cfg: DeployConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  wiring: PostgresRenameWiring,
  script: k8s.core.v1.ConfigMap,
  dependsOn: pulumi.Resource[],
): k8s.batch.v1.Job {
  return renameJob(cfg, provider, namespace, wiring, {
    name: "pg-rename-rls-roles",
    script,
    args: ["after-migrate"],
    env: [],
    dependsOn,
  });
}

function renameJob(
  cfg: DeployConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  wiring: PostgresRenameWiring,
  job: {
    name: string;
    script: k8s.core.v1.ConfigMap;
    args: string[];
    env: k8s.types.input.core.v1.EnvVar[];
    dependsOn: pulumi.Resource[];
  },
): k8s.batch.v1.Job {
  const labels = commonLabels("pg-rename");
  const fromSecret = (name: pulumi.Input<string>, key: string) => ({ secretKeyRef: { name, key } });

  return new k8s.batch.v1.Job(
    job.name,
    {
      metadata: { namespace, labels },
      spec: {
        backoffLimit: JOB_DEFAULTS.backoffLimit,
        ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
        template: {
          // A rotated runtime or scaler password changes the template, so the
          // Job is replaced and sets it: nothing else reconciles these roles.
          metadata: { labels, annotations: secretChecksumAnnotations(secretChecksum(wiring.passwords)) },
          spec: {
            enableServiceLinks: false, // see platform/security.ts — service-link env collisions
            restartPolicy: "OnFailure",
            ...onNodeGroup(cfg.nodeGroups.app),
            containers: [
              {
                name: "psql",
                image: "postgres:17-alpine",
                securityContext: hardenedJobSecurityContext(),
                resources: BOOTSTRAP_JOB_RESOURCES,
                env: [
                  { name: "PGHOST", value: wiring.rwHost },
                  { name: "PGPORT", value: String(PORT.postgres) },
                  { name: "PGSSLMODE", value: "require" },
                  { name: "PGUSER", valueFrom: fromSecret(wiring.superuserSecret, "username") },
                  { name: "PGPASSWORD", valueFrom: fromSecret(wiring.superuserSecret, "password") },
                  { name: "ROLE_PASSWORD", valueFrom: fromSecret(wiring.appSecret, "password") },
                  { name: "RUNTIME_PASSWORD", valueFrom: fromSecret(wiring.runtimeSecret, "password") },
                  { name: "SCALER_PASSWORD", valueFrom: fromSecret(wiring.scalerSecret, "password") },
                  { name: "SCALER_CONNECTION_LIMIT", value: String(KEDA_SCALER_CONNECTION_LIMIT) },
                  ...job.env,
                ],
                command: ["sh", "/script/rename-legacy-names.sh", ...job.args],
                volumeMounts: [{ name: "script", mountPath: "/script" }],
              },
            ],
            volumes: [{ name: "script", configMap: { name: job.script.metadata.name } }],
          },
        },
      },
    },
    // The superuser Secret appears once the operator has reconciled the Cluster.
    { provider, dependsOn: [job.script, ...job.dependsOn], customTimeouts: { create: "15m", update: "15m" } },
  );
}
