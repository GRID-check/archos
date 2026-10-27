import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { BOOTSTRAP_JOB_RESOURCES, JOB_DEFAULTS, PORT } from "../constants";
import { commonLabels } from "../platform/namespaces";
import { onNodeGroup } from "../platform/scheduling";
import { hardenedJobSecurityContext } from "../platform/security";

/** The application databases. Before ADR-0145 (row 10d) they were `aiq_jobs` and `aiq_checkpoints`. */
export const JOBS_DB = "grid_jobs";
export const CHECKPOINTS_DB = "grid_checkpoints";

/** The script that renames the databases and the owner role, shared with Compose's `postgres-rename`. */
export const RENAME_SCRIPT = resolve(__dirname, "../../../postgres/rename-to-grid.sh");

/**
 * The Job that renames `aiq_jobs`, `aiq_checkpoints` and the role `aiq` to their
 * grid names (`deploy/postgres/rename-to-grid.sh`), on every deploy before
 * anything connects with the new names: the init Job waits on it, and every
 * tier on the init Job. The second run, and a fresh cluster bootstrapped with
 * the new names, change nothing.
 *
 * It logs in as CloudNativePG's `postgres` superuser (`enableSuperuserAccess`
 * on the Cluster, its Secret `<cluster>-superuser`): a database can only be
 * renamed by a superuser or by its owner holding CREATEDB, and a role never by
 * itself, and the app role has neither. A rename refuses new sessions to the
 * old database and ends the open ones, so the deploy that carries it is a short
 * outage for the backend tiers, which the release note says. The operator sets
 * the renamed role's password from the app Secret itself; the script sets it
 * too, because a rename clears an MD5 hash.
 */
export function installPostgresRename(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  opts: { rwHost: string; superuserSecret: string; appSecret: pulumi.Input<string>; dependsOn: pulumi.Resource[] },
): k8s.batch.v1.Job {
  const labels = commonLabels("pg-rename");
  const script = new k8s.core.v1.ConfigMap(
    "pg-rename-script",
    { metadata: { namespace, labels }, data: { "rename-to-grid.sh": readFileSync(RENAME_SCRIPT, "utf8") } },
    // The Job runs again when the script changes.
    { provider, replaceOnChanges: ["data"] },
  );
  const fromSecret = (name: pulumi.Input<string>, key: string) => ({ secretKeyRef: { name, key } });

  return new k8s.batch.v1.Job(
    "pg-rename-to-grid",
    {
      metadata: { namespace, labels },
      spec: {
        backoffLimit: JOB_DEFAULTS.backoffLimit,
        ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
        template: {
          metadata: { labels },
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
                  { name: "PGHOST", value: opts.rwHost },
                  { name: "PGPORT", value: String(PORT.postgres) },
                  { name: "PGSSLMODE", value: "require" },
                  { name: "PGUSER", valueFrom: fromSecret(opts.superuserSecret, "username") },
                  { name: "PGPASSWORD", valueFrom: fromSecret(opts.superuserSecret, "password") },
                  { name: "GRID_PASSWORD", valueFrom: fromSecret(opts.appSecret, "password") },
                ],
                command: ["sh", "/script/rename-to-grid.sh"],
                volumeMounts: [{ name: "script", mountPath: "/script" }],
              },
            ],
            volumes: [{ name: "script", configMap: { name: script.metadata.name } }],
          },
        },
      },
    },
    // The superuser Secret appears once the operator has reconciled the Cluster.
    { provider, dependsOn: [script, ...opts.dependsOn], customTimeouts: { create: "15m", update: "15m" } },
  );
}
