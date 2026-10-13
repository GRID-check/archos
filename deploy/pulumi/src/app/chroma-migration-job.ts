import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GridConfig, appPullPolicy, backendImage, pullPolicyFor } from "../config";
import { CHROMA_MIGRATION, UID } from "../constants";
import { commonLabels } from "../platform/namespaces";
import { onNodeGroup } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import { AppSecrets, AppWiring, backendEnv } from "./config";

type EnvVar = k8s.types.input.core.v1.EnvVar;

/** The exporter in the repository (`deploy/migration/`), carried into the pod by ConfigMap. */
export const EXPORTER_SOURCE = resolve(__dirname, "../../../migration/chroma_export.py");

/** Mount points inside the pod. */
const MOUNT = {
  /** The retained Chroma claim, read-only: the exporter's `--persist-dir`. */
  chroma: "/chroma",
  /** The scratch volume both steps share. */
  exchange: "/exchange",
  /** The exporter script from the ConfigMap. */
  migration: "/migration",
} as const;

/**
 * Paths on the scratch volume. The exporter also stages its copy of the
 * persist dir here (beside `--out`, its default): Chroma cannot open a
 * read-only directory.
 */
const SCRATCH = {
  /** What the exporter writes and the importer reads (`--out` / `--in`). */
  export: `${MOUNT.exchange}/export`,
  /** uv's cache: the environment holding the `chromadb` the script pins. */
  uvCache: `${MOUNT.exchange}/uv-cache`,
  /** HOME and TMPDIR of the exporter: the root filesystem is read-only. */
  home: `${MOUNT.exchange}/home`,
  tmp: `${MOUNT.exchange}/tmp`,
} as const;

/** The exporter's environment: everything it writes on the scratch volume, nothing on the root. */
function exporterEnv(): EnvVar[] {
  return [
    { name: "UV_CACHE_DIR", value: SCRATCH.uvCache },
    // The image's Python 3.12, never one uv would download.
    { name: "UV_PYTHON_DOWNLOADS", value: "never" },
    { name: "PYTHONUNBUFFERED", value: "1" },
    { name: "HOME", value: SCRATCH.home },
    { name: "TMPDIR", value: SCRATCH.tmp },
    // chromadb reports usage to PostHog unless told not to.
    { name: "ANONYMIZED_TELEMETRY", value: "False" },
  ];
}

/** The exporter source, or a plan-time error naming the file the Job needs. */
function exporterScript(): string {
  try {
    return readFileSync(EXPORTER_SOURCE, "utf8");
  } catch (error) {
    throw new Error(
      `grid-oib:chromaMigration needs the exporter at ${EXPORTER_SOURCE}, which cannot be read ` +
        `(${(error as Error).message}). Deploy from a checkout that has deploy/migration/.`,
    );
  }
}

/**
 * Moves the retired Chroma store into Qdrant, once (ADR-0104). Opt-in
 * (`chromaMigration`), on the deploy that removes Chroma or any after it; the
 * order of operations is the Qdrant runbook's "Migrating from Chroma on
 * Kubernetes".
 *
 * One pod, two steps over a scratch volume they share:
 *
 * 1. `export` (init container) runs `deploy/migration/chroma_export.py` with
 *    `uv run --script`, which installs the `chromadb` the script pins (the
 *    release the Chroma server ran) in a pinned uv/Python image; the server
 *    image has no Python (see `CHROMA_MIGRATION.exporterImage`). It reads the
 *    old `data-chroma-0`, mounted read-only: nothing this Job does can change
 *    the one copy of the Chroma data.
 * 2. `import`, in the backend image with the backend's Qdrant URL and key,
 *    runs `scripts/import_vectors.py --verify`: 0 is in step, 1 is drift, 2 is
 *    Qdrant unreachable or the export invalid.
 *
 * The scratch volume is a generic ephemeral claim on the stack's StorageClass,
 * not an emptyDir: an export of a large store would otherwise fill the node's
 * own disk and evict its neighbours. `restartPolicy: OnFailure` retries a step
 * inside the same pod, so a failed import reruns against the export already
 * on the volume.
 *
 * Not awaited by Pulumi (`skipAwait`): a large store runs for longer than the
 * deploy pipeline's timeout, and a timeout mid-`up` leaves the stack with
 * pending operations. The operator watches the Job. It waits for every
 * backend tier, so nothing that still writes Chroma is running when it reads,
 * and it never schedules beside a Chroma pod (below), so on the deploy that
 * removes Chroma it starts once the old server is gone.
 */
export function migrateChromaToQdrant(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): k8s.batch.v1.Job {
  const labels = commonLabels(CHROMA_MIGRATION.name);
  const { claim, scratchSize } = cfg.chromaMigration;

  // Read, never managed: a missing claim fails the plan here, instead of a
  // pod that never schedules. Pulumi drops a read resource from its state
  // without touching the object, so this cannot delete the claim either.
  const retained = k8s.core.v1.PersistentVolumeClaim.get(
    "chroma-migration-claim",
    pulumi.interpolate`${w.namespace}/${claim}`,
    { provider: w.provider },
  );

  const script = new k8s.core.v1.ConfigMap(
    CHROMA_MIGRATION.exporterConfigMap,
    {
      metadata: { name: CHROMA_MIGRATION.exporterConfigMap, namespace: w.namespace, labels },
      data: { "chroma_export.py": exporterScript() },
    },
    { provider: w.provider },
  );

  const exchangeMount = { name: "exchange", mountPath: MOUNT.exchange };
  const readOnlyRoot = { ...hardenedContainerSecurityContext(), readOnlyRootFilesystem: true };
  const image = CHROMA_MIGRATION.exporterImage;

  return new k8s.batch.v1.Job(
    CHROMA_MIGRATION.name,
    {
      metadata: {
        name: CHROMA_MIGRATION.name,
        namespace: w.namespace,
        labels,
        annotations: { "pulumi.com/skipAwait": "true" },
      },
      spec: {
        backoffLimit: CHROMA_MIGRATION.backoffLimit,
        ttlSecondsAfterFinished: CHROMA_MIGRATION.ttlSecondsAfterFinished,
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false, // see platform/security.ts — service-link env collisions
            imagePullSecrets: w.imagePullSecrets,
            restartPolicy: "OnFailure",
            securityContext: {
              runAsNonRoot: true,
              runAsUser: UID.backend,
              runAsGroup: UID.backend,
              // Owns the fresh scratch volume; the read-only claim is left as it is.
              fsGroup: UID.backend,
              fsGroupChangePolicy: "OnRootMismatch",
            },
            ...onNodeGroup(cfg.nodeGroups.batch),
            // Never beside a Chroma pod. On the deploy that removes Chroma the
            // Job is created before the old StatefulSet is deleted (Pulumi
            // deletes last); on another node the ReadWriteOnce claim cannot
            // attach until that pod is gone, so the export never reads a store
            // a server still has open. Once Chroma is gone this matches nothing.
            affinity: {
              podAntiAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: [
                  {
                    labelSelector: { matchLabels: { "app.kubernetes.io/name": "chroma" } },
                    topologyKey: "kubernetes.io/hostname",
                  },
                ],
              },
            },
            volumes: [
              { name: "chroma", persistentVolumeClaim: { claimName: claim, readOnly: true } },
              {
                name: "exchange",
                ephemeral: {
                  volumeClaimTemplate: {
                    metadata: { labels },
                    spec: {
                      accessModes: ["ReadWriteOnce"],
                      storageClassName: cfg.storage.className,
                      resources: { requests: { storage: scratchSize } },
                    },
                  },
                },
              },
              { name: "migration", configMap: { name: CHROMA_MIGRATION.exporterConfigMap } },
            ],
            initContainers: [
              {
                name: "export",
                image,
                imagePullPolicy: pullPolicyFor(image),
                securityContext: readOnlyRoot,
                command: [
                  "sh",
                  "-c",
                  [
                    "set -eu",
                    `mkdir -p ${SCRATCH.home} ${SCRATCH.tmp}`,
                    `exec uv run --script ${MOUNT.migration}/chroma_export.py ` +
                      `--persist-dir ${MOUNT.chroma} --out ${SCRATCH.export}`,
                  ].join("\n"),
                ],
                env: exporterEnv(),
                volumeMounts: [
                  { name: "chroma", mountPath: MOUNT.chroma, readOnly: true },
                  exchangeMount,
                  { name: "migration", mountPath: MOUNT.migration, readOnly: true },
                ],
                resources: CHROMA_MIGRATION.exporterResources,
              },
            ],
            containers: [
              {
                name: "import",
                image: backendImage(cfg),
                imagePullPolicy: appPullPolicy(cfg, backendImage(cfg)),
                securityContext: hardenedContainerSecurityContext(),
                command: ["python", "scripts/import_vectors.py", "--in", SCRATCH.export, "--verify"],
                env: backendEnv(w, "grid-chroma-migration"),
                volumeMounts: [exchangeMount],
                resources: CHROMA_MIGRATION.importerResources,
              },
            ],
          },
        },
      },
    },
    {
      provider: w.provider,
      dependsOn: [secrets.secret, script, retained, ...dependsOn],
      // Once, not once per deploy. A Job's spec is immutable, so the next
      // backend image would otherwise replace it and run the import again
      // over a store that has moved on, bringing back the chunks of every
      // document deleted or re-indexed since. To run it again, switch the
      // flag off for one deploy and on for the next.
      ignoreChanges: ["spec"],
      // A fixed name: should it ever be replaced, the old Job goes first.
      deleteBeforeReplace: true,
    },
  );
}
