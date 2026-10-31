import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { DeployConfig } from "../config";
import { appPullPolicy, geometryImage } from "../config/images";
import { assertMemoryFitsLimit, toResourceRequirements } from "../config/resources";
import { commonLabels } from "../platform/namespaces";
import { onNodeGroup, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import { ROLLOUT, gracefulShutdown, secretChecksumAnnotations, surgeRollout } from "../platform/rollout";
import { AppSecrets, AppWiring, langfuseApiEnv, sref } from "./config";
import { UID } from "../constants";

/** Where `python -m geometry_service` binds (`PORT`). Kept here, not in `constants.ts`, beside its only users. */
export const GEOMETRY_PORT = 8100;

type EnvVar = k8s.types.input.core.v1.EnvVar;

/** The Service name, and so the host the BFF dials. */
export const GEOMETRY_NAME = "geometry";

/** In-cluster URL the frontend's `GEOMETRY_SERVICE_URL` points at. Deterministic, so the wiring can carry it before the Deployment exists. */
export const GEOMETRY_URL = `http://${GEOMETRY_NAME}:${GEOMETRY_PORT}`;

/**
 * The geometry pod's own ingress rule (rule 21 of `network-policies.ts`): the frontend alone, the
 * BFF being its one caller, instead of the blanket same-namespace allow it is withheld from. Egress
 * stays open, as for every app pod: it reaches Dragonfly, the object store's presigned URL (the BFF
 * signs it into each request) and Langfuse.
 */
export function geometryFrontendOnly(
  mk: (name: string, spec: k8s.types.input.networking.v1.NetworkPolicySpec) => k8s.networking.v1.NetworkPolicy,
): k8s.networking.v1.NetworkPolicy {
  return mk("geometry-frontend-only", {
    podSelector: { matchLabels: { "app.kubernetes.io/name": GEOMETRY_NAME } },
    policyTypes: ["Ingress"],
    ingress: [
      {
        from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "frontend" } } }],
        ports: [{ protocol: "TCP", port: GEOMETRY_PORT }],
      },
    ],
  });
}

export interface Geometry {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
}

/** The frontend's `GEOMETRY_SERVICE_URL`, exactly when the service runs; off, the route answers 503. */
export function geometryFrontendEnv(cfg: DeployConfig): EnvVar[] {
  return cfg.geometry.enabled ? [{ name: "GEOMETRY_SERVICE_URL", value: GEOMETRY_URL }] : [];
}

/** The service's environment: the internal token and the envelope's key, the shared cache, the BFF. Exported for the spec. */
export function geometryEnv(cfg: DeployConfig): EnvVar[] {
  return [
    { name: "APP_ENV", value: "production" },
    { name: "LOG_LEVEL", value: "INFO" },
    { name: "HOST", value: "0.0.0.0" },
    { name: "PORT", value: String(GEOMETRY_PORT) },
    // Checks the BFF's token and the signed envelope (agent.common.envelope_auth).
    sref("INTERNAL_API_TOKEN"),
    // Tier B, the element index (authenticated: the URL carries the password).
    sref("REDIS_URL"),
    // Scores a cold build on the BFF's trace (`geometry-cold-ms`); nothing when Langfuse is off.
    ...langfuseApiEnv(cfg),
  ];
}

/**
 * The geometry service (ADR-0149, `apps/geometry`): element boxes, proximity, rooms, clashes and
 * box diffs over IFC models. Cluster-internal only: a ClusterIP Service and no route, because the
 * BFF's geometry route is its one caller and every agent reaches it through the door. It holds no
 * access rules of its own; it checks the internal token and the signed envelope, and fetches only
 * the model sources the BFF signed after its read gate.
 *
 * Its own Deployment so a parsed model's memory (20x to 140x the file) is sized here and never on
 * the api pods. It scales by replicas; the element index lives in the shared cache, so any replica
 * answers a warmed model without opening it. `/healthz` is liveness, `/readyz` readiness (the
 * engine imports, the token is set).
 */
export function installGeometry(
  w: AppWiring,
  cfg: DeployConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): Geometry {
  const labels = commonLabels(GEOMETRY_NAME);
  const shutdown = gracefulShutdown(ROLLOUT.api, "python");
  assertMemoryFitsLimit(GEOMETRY_NAME, cfg.geometry.resources);
  const image = geometryImage(cfg);

  const deployment = new k8s.apps.v1.Deployment(
    GEOMETRY_NAME,
    {
      metadata: { name: GEOMETRY_NAME, namespace: w.namespace, labels },
      spec: {
        replicas: cfg.geometry.replicas,
        selector: { matchLabels: labels },
        ...surgeRollout(ROLLOUT.api),
        template: {
          metadata: { labels, annotations: secretChecksumAnnotations(secrets.checksum) },
          spec: {
            enableServiceLinks: false, // see platform/security.ts — service-link env collisions
            automountServiceAccountToken: false,
            imagePullSecrets: w.imagePullSecrets,
            terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
            // The image's `USER 1000:1000`, the backend image's lineage.
            securityContext: { runAsNonRoot: true, runAsUser: UID.backend, runAsGroup: UID.backend },
            topologySpreadConstraints: spreadAcrossNodes(labels),
            ...onNodeGroup(cfg.nodeGroups.app),
            containers: [
              {
                name: GEOMETRY_NAME,
                image,
                imagePullPolicy: appPullPolicy(cfg, image),
                securityContext: hardenedContainerSecurityContext(),
                lifecycle: shutdown.lifecycle,
                ports: [{ containerPort: GEOMETRY_PORT, name: "http" }],
                env: geometryEnv(cfg),
                resources: toResourceRequirements(cfg.geometry.resources),
                readinessProbe: {
                  httpGet: { path: "/readyz", port: GEOMETRY_PORT },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                  timeoutSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/healthz", port: GEOMETRY_PORT },
                  initialDelaySeconds: 20,
                  periodSeconds: 20,
                  timeoutSeconds: 10,
                  failureThreshold: 6,
                },
              },
            ],
          },
        },
      },
    },
    { provider: w.provider, dependsOn: [secrets.secret, ...dependsOn] },
  );

  const service = new k8s.core.v1.Service(
    GEOMETRY_NAME,
    {
      metadata: { name: GEOMETRY_NAME, namespace: w.namespace, labels },
      spec: {
        type: "ClusterIP",
        selector: labels,
        ports: [{ port: GEOMETRY_PORT, targetPort: GEOMETRY_PORT, name: "http" }],
      },
    },
    { provider: w.provider, dependsOn: deployment },
  );

  return { deployment, service };
}
