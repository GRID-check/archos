import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { DeployConfig } from "../config";
import { appPullPolicy, geometryImage } from "../config/images";
import { assertMemoryFitsLimit, toResourceRequirements } from "../config/resources";
import { commonLabels } from "../platform/namespaces";
import { onNodeGroup, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import { ROLLOUT, gracefulShutdown, secretChecksumAnnotations, surgeRollout } from "../platform/rollout";
import { AppSecrets, AppWiring, sref } from "./config";
import { PORT, UID } from "../constants";

type EnvVar = k8s.types.input.core.v1.EnvVar;

/** The Service name, and so the host the BFF dials. */
export const GEOMETRY_NAME = "geometry";

/** In-cluster URL the frontend's `GEOMETRY_SERVICE_URL` points at. Deterministic, so the wiring can carry it before the Deployment exists. */
export const GEOMETRY_URL = `http://${GEOMETRY_NAME}:${PORT.geometry}`;

export interface Geometry {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
}

/** The service's environment: the internal token and the envelope's key, the shared cache, the BFF. Exported for the spec. */
export function geometryEnv(): EnvVar[] {
  return [
    { name: "APP_ENV", value: "production" },
    { name: "LOG_LEVEL", value: "INFO" },
    { name: "HOST", value: "0.0.0.0" },
    { name: "PORT", value: String(PORT.geometry) },
    // Checks the BFF's token and the signed envelope (agent.common.envelope_auth).
    sref("INTERNAL_API_TOKEN"),
    // Tier B, the element index (authenticated: the URL carries the password).
    sref("REDIS_URL"),
    // The model's source is resolved through the BFF (`/api/internal/bim/source`).
    { name: "FRONTEND_INTERNAL_URL", value: `http://frontend:${PORT.frontend}` },
  ];
}

/**
 * The geometry service (ADR-0149, `apps/geometry`): element boxes, proximity, rooms, clashes and
 * box diffs over IFC models. Cluster-internal only: a ClusterIP Service and no route, because the
 * BFF's geometry route is its one caller and every agent reaches it through the door. It holds no
 * access rules of its own; it checks the internal token and the signed envelope and resolves the
 * model through the BFF with the envelope's scope.
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
            securityContext: { runAsNonRoot: true, runAsUser: UID.geometry, runAsGroup: UID.geometry },
            topologySpreadConstraints: spreadAcrossNodes(labels),
            ...onNodeGroup(cfg.nodeGroups.app),
            containers: [
              {
                name: GEOMETRY_NAME,
                image,
                imagePullPolicy: appPullPolicy(cfg, image),
                securityContext: hardenedContainerSecurityContext(),
                lifecycle: shutdown.lifecycle,
                ports: [{ containerPort: PORT.geometry, name: "http" }],
                env: geometryEnv(),
                resources: toResourceRequirements(cfg.geometry.resources),
                readinessProbe: {
                  httpGet: { path: "/readyz", port: PORT.geometry },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                  timeoutSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/healthz", port: PORT.geometry },
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
        ports: [{ port: PORT.geometry, targetPort: PORT.geometry, name: "http" }],
      },
    },
    { provider: w.provider, dependsOn: deployment },
  );

  return { deployment, service };
}
