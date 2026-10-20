import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, pullPolicyFor } from "../config";
import { commonLabels } from "../platform/namespaces";
import { onNodeGroup } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import { ROLLOUT, gracefulShutdown, orderedRollout } from "../platform/rollout";
import { GEOCODER, PORT, UID } from "../constants";

export interface Geocoder {
  statefulSet: k8s.apps.v1.StatefulSet;
  service: k8s.core.v1.Service;
  /** In-cluster URL the frontend's `GRID_GEOCODER_URL` points at. */
  url: pulumi.Output<string>;
}

/** Where the jar and the index live on the volume. Photon reads `<index>/photon_data`. */
const JAR = `${GEOCODER.dataPath}/photon-${GEOCODER.photonVersion}.jar`;
const INDEX_DIR = `${GEOCODER.dataPath}/current`;

/**
 * The init container's script (busybox `sh` on alpine). Idempotent, and it
 * only ever replaces a working index with a verified one:
 *
 * 1. The jar: fetched when missing or when its sha256 is not the pinned one,
 *    then checked against that pin. A mismatch stops the pod, because a jar
 *    nobody pinned is code nobody reviewed.
 * 2. The index: kept while younger than `INDEX_MAX_AGE_DAYS`. Otherwise the
 *    tarball is fetched next to the live index, checked against the `.md5`
 *    the same server publishes, unpacked, and swapped in by two renames. Any
 *    failure keeps the old index and serves it; only a pod with no index at
 *    all fails, so a first start without egress is visible as Init:Error.
 *
 * The tarball is written to the volume rather than streamed through tar,
 * because busybox `sh` has no process substitution to checksum the stream on
 * the way through; it is deleted once unpacked.
 */
export function fetchScript(dataPath: string = GEOCODER.dataPath): string {
  return [
    "set -eu",
    `cd ${dataPath}`,
    `jar=photon-${GEOCODER.photonVersion}.jar`,
    "sha() { sha256sum \"$1\" 2>/dev/null | cut -d' ' -f1; }",
    'if [ "$(sha "$jar")" != "$JAR_SHA256" ]; then',
    '  echo "fetching $jar"',
    '  rm -f "$jar" "$jar.part"',
    '  wget -q -O "$jar.part" "$JAR_URL"',
    '  [ "$(sha "$jar.part")" = "$JAR_SHA256" ] || { echo "photon jar: sha256 mismatch, refusing it" >&2; rm -f "$jar.part"; exit 1; }',
    '  mv "$jar.part" "$jar"',
    "fi",
    'for f in photon-*.jar; do [ "$f" = "$jar" ] || rm -f "$f"; done',
    "now=$(date +%s)",
    "if [ -d current/photon_data ] && [ -f current/.fetched-at ] && [ $((now - $(cat current/.fetched-at))) -lt $((INDEX_MAX_AGE_DAYS * 86400)) ]; then",
    '  echo "index is fresh"',
    "  exit 0",
    "fi",
    "rm -rf next old && mkdir next",
    'if wget -q -O next/index.tar.bz2 "$INDEX_URL" \\',
    '  && wget -q -O next/index.md5 "$INDEX_URL.md5" \\',
    "  && [ \"$(md5sum next/index.tar.bz2 | cut -d' ' -f1)\" = \"$(cut -d' ' -f1 next/index.md5)\" ] \\",
    "  && tar -xjf next/index.tar.bz2 -C next \\",
    "  && [ -d next/photon_data ]; then",
    "  rm -f next/index.tar.bz2 next/index.md5",
    '  echo "$now" > next/.fetched-at',
    "  if [ -d current ]; then mv current old; fi",
    "  mv next current",
    "  rm -rf old",
    '  echo "index replaced"',
    "elif [ -d current/photon_data ]; then",
    "  rm -rf next",
    '  echo "index refresh failed; serving the previous index" >&2',
    "else",
    "  rm -rf next",
    '  echo "no index on the volume and the download failed" >&2',
    "  exit 1",
    "fi",
  ].join("\n");
}

/**
 * The geocoder (ADR-0118): Photon over the Austrian OSM extract, the provider
 * behind `GET /api/geocode` and the project creation dialog's address search.
 *
 * Every keystroke of an address a person types reaches this pod, and an
 * address is client data. That is why it runs here rather than at
 * photon.komoot.io: the query never leaves the cluster.
 *
 * A StatefulSet of one, with a volume for the index: an emptyDir would fetch
 * a gigabyte on every restart, and a restart during an outage of the download
 * server would leave the dialog without search. The search itself is
 * stateless and the frontend fails open (`searchPhoton` answers `[]` on any
 * error, and the field stays plain text), so one replica and the gap during
 * its rollout are acceptable; nothing waits on it.
 *
 * `platform/network-policies.ts` admits the frontend alone and lets the pod
 * out only to DNS and HTTPS, which the init container needs for the jar and
 * the index.
 */
export function installGeocoder(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): Geocoder {
  const { name } = GEOCODER;
  const labels = commonLabels(name);
  const geo = cfg.geocoder;
  const probe = { httpGet: { path: "/status", port: PORT.geocoder } };

  const statefulSet = new k8s.apps.v1.StatefulSet(
    name,
    {
      metadata: { name, namespace, labels },
      spec: {
        serviceName: `${name}-headless`,
        replicas: 1,
        // The index is a download, not data: dropping the claim with the
        // StatefulSet costs one fetch. Retain anyway, as every claim here
        // does, so a replace never turns into a re-download during an outage.
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
        ...orderedRollout(ROLLOUT.dataPlane),
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false, // see platform/security.ts — service-link env collisions
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: UID.geocoder,
              runAsGroup: UID.geocoder,
              fsGroup: UID.geocoder,
            },
            terminationGracePeriodSeconds: gracefulShutdown(ROLLOUT.dataPlane).terminationGracePeriodSeconds,
            ...onNodeGroup(cfg.nodeGroups.data),
            initContainers: [
              {
                name: "fetch",
                image: geo.fetchImage,
                imagePullPolicy: pullPolicyFor(geo.fetchImage),
                securityContext: hardenedContainerSecurityContext(),
                command: ["/bin/sh", "-c", fetchScript()],
                env: [
                  {
                    name: "JAR_URL",
                    value: `https://github.com/komoot/photon/releases/download/${GEOCODER.photonVersion}/photon-${GEOCODER.photonVersion}.jar`,
                  },
                  { name: "JAR_SHA256", value: GEOCODER.photonJarSha256 },
                  { name: "INDEX_URL", value: geo.indexUrl },
                  { name: "INDEX_MAX_AGE_DAYS", value: String(geo.indexMaxAgeDays) },
                ],
                volumeMounts: [{ name: "data", mountPath: GEOCODER.dataPath }],
                resources: GEOCODER.fetchResources,
              },
            ],
            containers: [
              {
                name: "photon",
                image: geo.image,
                imagePullPolicy: pullPolicyFor(geo.image),
                securityContext: hardenedContainerSecurityContext(),
                // `command`, not `args`: the temurin entrypoint only imports CA
                // certificates, which a server that dials nothing has no use for.
                command: [
                  "java",
                  `-Xmx${GEOCODER.javaHeap}`,
                  `-Xms${GEOCODER.javaHeap}`,
                  "-jar",
                  JAR,
                  "serve",
                  "-data-dir",
                  INDEX_DIR,
                  "-listen-ip",
                  "0.0.0.0",
                  "-listen-port",
                  String(PORT.geocoder),
                  "-max-results",
                  String(GEOCODER.maxResults),
                  "-default-language",
                  "de",
                ],
                ports: [{ containerPort: PORT.geocoder, name: "http" }],
                volumeMounts: [{ name: "data", mountPath: GEOCODER.dataPath }],
                resources: GEOCODER.resources,
                // `/status` answers once the embedded OpenSearch has opened the
                // index. The first boot on a cold volume takes a while.
                startupProbe: { ...probe, periodSeconds: 10, failureThreshold: 30 },
                readinessProbe: { ...probe, periodSeconds: 10, timeoutSeconds: 3 },
                livenessProbe: { ...probe, periodSeconds: 20, timeoutSeconds: 5, failureThreshold: 6 },
              },
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: "data" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              storageClassName: cfg.storage.className,
              resources: { requests: { storage: geo.storageSize } },
            },
          },
        ],
      },
    },
    {
      provider,
      dependsOn,
      // Immutable volumeClaimTemplates: grow via a PVC patch (see seaweedfs.ts).
      ignoreChanges: ["spec.volumeClaimTemplates"],
      // Fixed-name StatefulSet: create-before-delete collides with the old one.
      deleteBeforeReplace: true,
    },
  );

  new k8s.core.v1.Service(
    `${name}-headless`,
    {
      metadata: { name: `${name}-headless`, namespace, labels },
      spec: {
        clusterIP: "None",
        selector: labels,
        ports: [{ port: PORT.geocoder, name: "http" }],
      },
    },
    { provider },
  );

  const service = new k8s.core.v1.Service(
    name,
    {
      metadata: { name, namespace, labels },
      spec: {
        selector: labels,
        ports: [{ port: PORT.geocoder, targetPort: PORT.geocoder, name: "http" }],
      },
    },
    { provider, dependsOn: statefulSet },
  );

  return { statefulSet, service, url: pulumi.output(`http://${name}:${PORT.geocoder}`) };
}
