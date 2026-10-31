import { describe, it, expect, beforeAll } from "vitest";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";
import { LEGACY_PROJECT } from "../names";

/**
 * The geometry service (ADR-0149). What would plan clean and still be wrong: a route or a
 * LoadBalancer that puts it outside the cluster (its only caller is the BFF), probes on paths it
 * does not serve, a frontend that dials it while it is off, or a pod without the token it checks.
 */

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, any> }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } } };
    },
    call: () => ({}),
  },
  LEGACY_PROJECT,
  "test",
  false,
);

function find(type: string, name: string) {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  if (!hit) throw new Error(`no ${type} named "${name}"`);
  return hit;
}

function resolve<T>(value: pulumi.Input<T>): Promise<T> {
  return new Promise((done) => pulumi.output(value).apply((v) => done(v as T)));
}

describe("geometry", () => {
  let off = true;
  let envOn: k8s.types.input.core.v1.EnvVar[] = [];
  let envOff: k8s.types.input.core.v1.EnvVar[] = [];
  let url = "";

  beforeAll(async () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), [`${LEGACY_PROJECT}:observabilityEnabled`]: "false", [`${LEGACY_PROJECT}:geometryEnabled`]: "true" });
    const { loadConfig } = await import("../config");
    const { installGeometry, GEOMETRY_URL } = await import("./geometry");
    const { buildSecrets, frontendEnv } = await import("./config");
    const cfg = loadConfig();
    off = !cfg.geometry.enabled;
    url = GEOMETRY_URL;
    const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
    const wiring = {
      cfg,
      namespace: "app",
      provider,
      redisUrl: pulumi.output("redis://dragonfly:6379"),
      seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
      seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
      qdrantUrl: pulumi.output("http://qdrant:6333"),
      dsn: () => pulumi.output("postgresql://x"),
      imagePullSecrets: [],
    };
    const g = installGeometry(wiring, cfg, buildSecrets(wiring), []);
    envOn = frontendEnv(wiring);
    envOff = frontendEnv({ ...wiring, cfg: { ...cfg, geometry: { ...cfg.geometry, enabled: false } } });
    await new Promise((done) => g.service.id.apply(done));
  });

  it("is switched on by the stack, and the frontend gets its URL exactly then", () => {
    expect(off).toBe(false);
    expect(envOn).toContainEqual({ name: "GEOMETRY_SERVICE_URL", value: url });
    expect(envOff.some((e) => e.name === "GEOMETRY_SERVICE_URL")).toBe(false);
    expect(url).toBe("http://geometry:8100");
  });

  it("is a ClusterIP Service and nothing else reaches it from outside", async () => {
    const spec = await resolve(find("kubernetes:core/v1:Service", "geometry").inputs.spec);
    expect(spec.type).toBe("ClusterIP");
    expect(RESOURCES.some((r) => /Ingress|HTTPRoute/.test(r.type) && r.name.includes("geometry"))).toBe(false);
  });

  it("probes the paths the service serves, and carries the token it checks", async () => {
    const spec = await resolve(find("kubernetes:apps/v1:Deployment", "geometry").inputs.spec);
    const c = spec.template.spec.containers[0];
    expect(c.readinessProbe.httpGet.path).toBe("/readyz");
    expect(c.livenessProbe.httpGet.path).toBe("/healthz");
    expect(c.image).toMatch(/-geometry:/);
    const names = c.env.map((e: { name: string }) => e.name);
    expect(names).toEqual(expect.arrayContaining(["INTERNAL_API_TOKEN", "REDIS_URL", "FRONTEND_INTERNAL_URL", "PORT"]));
    expect(spec.template.spec.securityContext.runAsNonRoot).toBe(true);
  });
});
