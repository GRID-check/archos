import { beforeAll, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";
import { parseCollectorConfig, pipeline } from "../test-support/collector";
import type { CollectorConfig } from "./collector-config";

/**
 * The per-node agent: the node's kubelet and the annotated pods beside it, to
 * the gateway.
 *
 * Every failure here is a gap, not an error. An agent scraping every pod in
 * the cluster sends each series once per node; one without the node filter in
 * its discovery does the same; one exporting to PostHog itself is one more
 * holder of the token; a missing env var leaves `${env:…}` unresolved and the
 * agent refusing to start on every node at once.
 */

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } } };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

function resolve<T>(value: unknown): Promise<T> {
  return new Promise((done) => (pulumi.output(value) as pulumi.Output<T>).apply((v) => (done(v), v)));
}

function find(type: string, name: string) {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  if (!hit) throw new Error(`${type} ${name} was not created`);
  return hit;
}

async function deploy(values: Record<string, string>): Promise<void> {
  vi.resetModules();
  RESOURCES.length = 0;
  pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...values });
  await import("../../index");
  await new Promise((r) => setTimeout(r, 200));
}

describe("the node agent, with PostHog metrics on (the default)", () => {
  let agent: CollectorConfig;
  let pod: any;

  beforeAll(async () => {
    await deploy({});
    const data = await resolve<Record<string, string>>(find("kubernetes:core/v1:ConfigMap", "otel-agent").inputs.data);
    agent = parseCollectorConfig(data["collector.yaml"]);
    pod = (await resolve<any>(find("kubernetes:apps/v1:DaemonSet", "otel-agent").inputs.spec)).template.spec;
  }, 120_000);

  it("reads its own node's kubelet, every group of readings", () => {
    // `kubelet_stats`, the current id: upstream deprecated the `kubeletstats` alias.
    expect(agent.receivers.kubelet_stats).toMatchObject({
      auth_type: "serviceAccount",
      endpoint: "https://${env:K8S_NODE_IP}:10250",
      metric_groups: ["node", "pod", "container", "volume"],
    });
  });

  it("discovers only the pods on its own node, and keeps only the annotated, running ones", () => {
    const [scrape] = (agent.receivers["prometheus/pods"] as any).config.scrape_configs;
    expect(scrape.kubernetes_sd_configs).toEqual([
      { role: "pod", selectors: [{ role: "pod", field: "spec.nodeName=${env:K8S_NODE_NAME}" }] },
    ]);
    expect(scrape.relabel_configs.slice(0, 2)).toEqual([
      { source_labels: ["__meta_kubernetes_pod_annotation_prometheus_io_scrape"], action: "keep", regex: "true" },
      { source_labels: ["__meta_kubernetes_pod_phase"], action: "keep", regex: "Running" },
    ]);
  });

  it("scrapes each pod once, at the container port its annotation names", () => {
    // Discovery yields a target per declared port and per port-less (init)
    // container; without this a multi-port pod is scraped once per port.
    const [scrape] = (agent.receivers["prometheus/pods"] as any).config.scrape_configs;
    expect(scrape.relabel_configs).toContainEqual({
      source_labels: ["__meta_kubernetes_pod_container_port_number"],
      action: "keepequal",
      target_label: "__meta_kubernetes_pod_annotation_prometheus_io_port",
    });
    expect(scrape.relabel_configs.some((r: { target_label?: string }) => r.target_label === "__address__")).toBe(false);
  });

  it("sends everything to the gateway over OTLP, and takes no OTLP itself", () => {
    expect(agent.exporters["otlp_http/gateway"]).toMatchObject({ endpoint: "http://otel-collector:4318" });
    expect(agent.receivers).not.toHaveProperty("otlp");
    expect(agent.service.pipelines).toEqual({
      "metrics/node": pipeline(["otlp_http/gateway"], { receivers: ["kubelet_stats"] }),
      "metrics/pods": pipeline(["otlp_http/gateway"], { receivers: ["prometheus/pods"] }),
    });
  });

  it("holds no PostHog token: the gateway alone exports", async () => {
    const data = await resolve<Record<string, string>>(find("kubernetes:core/v1:ConfigMap", "otel-agent").inputs.data);
    expect(data["collector.yaml"]).not.toContain("phc_");
    expect(data["collector.yaml"]).not.toContain("posthog");
  });

  it("injects every env var its config references", () => {
    const names = pod.containers[0].env.map((e: { name: string }) => e.name);
    expect(names).toEqual(["K8S_NODE_NAME", "K8S_NODE_IP"]);
  });

  it("reads the API as its own service account, and never holds nodes/proxy, which is exec on every pod", async () => {
    expect(pod.serviceAccountName).toBe("otel-agent");
    const rules = await resolve<Array<{ resources: string[]; verbs: string[] }>>(
      find("kubernetes:rbac.authorization.k8s.io/v1:ClusterRole", "otel-agent").inputs.rules,
    );
    expect(rules).toEqual([
      { apiGroups: [""], resources: ["nodes/stats", "pods"], verbs: ["get", "list", "watch"] },
    ]);
  });
});

describe("the node agent, with PostHog metrics off", () => {
  it("is not deployed: it exists only to feed them", async () => {
    await deploy({ "grid-oib:posthogMetricsEnabled": "false" });
    expect(RESOURCES.some((r) => r.name === "otel-agent")).toBe(false);
  }, 120_000);
});
