import { describe, it, expect, beforeAll, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig, langfuseStackConfig } from "./src/test-support/stack-config";
import { SCRAPE_ANNOTATION } from "./src/platform/scrape";

/**
 * Every workload the node agents scrape (ADR-0119), across the whole program.
 *
 * An annotation is a promise nothing checks at runtime. One whose port no
 * container declares scrapes a closed port; one on a pod that rule 2 of
 * `network-policies.ts` withholds from the namespace, with no rule admitting
 * `otel-agent`, times out. Either reads in PostHog as a service that never
 * reported, which looks the same as one nobody annotated. This suite holds the
 * three together, and names the workloads, so dropping one is a decision.
 */

type Inputs = Record<string, any>;
const RESOURCES: Array<{ type: string; name: string; inputs: Inputs }> = [];

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

const POD_MAKERS = /:apps\/v1:(Deployment|StatefulSet|DaemonSet)$/;

interface Scraped {
  workload: string;
  appName: string | undefined;
  port: number;
  path: string;
  declared: number[];
}

async function render(values: Record<string, string>): Promise<void> {
  vi.resetModules();
  RESOURCES.length = 0;
  pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...values });
  const stack = (await import("./index")) as Record<string, unknown>;
  await Promise.all(
    Object.values(stack)
      .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
      .map((output) => new Promise((resolve) => output.apply(resolve))),
  );
}

/** Every pod template this program builds that asks to be scraped. */
function scrapedTemplates(): Scraped[] {
  return RESOURCES.filter((r) => POD_MAKERS.test(r.type)).flatMap((r) => {
    const template = r.inputs.spec.template;
    const annotations: Record<string, string> = template.metadata?.annotations ?? {};
    if (annotations[SCRAPE_ANNOTATION.scrape] !== "true") return [];
    return [
      {
        workload: `${r.type.split(":").pop()}/${r.name}`,
        appName: template.metadata?.labels?.["app.kubernetes.io/name"],
        port: Number(annotations[SCRAPE_ANNOTATION.port]),
        path: annotations[SCRAPE_ANNOTATION.path],
        declared: template.spec.containers.flatMap((c: any) => (c.ports ?? []).map((p: any) => p.containerPort)),
      },
    ];
  });
}

/** The app names rule 2 withholds from the namespace's wholesale allow. */
function withheld(): string[] {
  const intra = RESOURCES.find((r) => r.name === "allow-same-namespace")!.inputs.spec;
  return intra.podSelector.matchExpressions[0].values;
}

/** Whether some NetworkPolicy admits `otel-agent` to `port` on pods named `appName`. */
function agentAdmitted(appName: string, port: number): boolean {
  return RESOURCES.filter((r) => r.type.endsWith("NetworkPolicy")).some((r) => {
    const spec = r.inputs.spec;
    if (spec.podSelector?.matchLabels?.["app.kubernetes.io/name"] !== appName) return false;
    return (spec.ingress ?? []).some(
      (rule: any) =>
        rule.from?.some((f: any) => f.podSelector?.matchLabels?.["app.kubernetes.io/name"] === "otel-agent") &&
        rule.ports?.some((p: any) => p.port === port),
    );
  });
}

describe.each([
  ["single-node SeaweedFS", { "grid-oib:seaweedfsTopology": "single" }],
  ["split SeaweedFS", { "grid-oib:seaweedfsTopology": "split" }],
])("the scrape targets, with Langfuse and %s", (_topology, topology) => {
  let scraped: Scraped[];

  beforeAll(async () => {
    await render({ ...langfuseStackConfig(), ...topology });
    scraped = scrapedTemplates();
  }, 120_000);

  it("scrapes each annotated pod on a port its container declares", () => {
    for (const s of scraped) expect(s.declared, s.workload).toContain(s.port);
    for (const s of scraped) expect(s.path, s.workload).toMatch(/^\//);
  });

  it("admits the agent to every scraped pod the namespace's allow withholds", () => {
    const blocked = scraped.filter((s) => s.appName && withheld().includes(s.appName));
    for (const s of blocked) expect(agentAdmitted(s.appName!, s.port), s.workload).toBe(true);
  });

  it("scrapes the stores, the caches, the converter and the trace store, and not Qdrant twice", () => {
    const names = scraped.map((s) => s.workload);
    expect(names).toEqual(
      expect.arrayContaining([
        "Deployment/gotenberg",
        "StatefulSet/clickhouse",
        "Deployment/dragonfly",
        "Deployment/dragonfly-ratelimit",
        "Deployment/dragonfly-langfuse",
      ]),
    );
    expect(names.some((n) => n.includes("seaweedfs"))).toBe(true);
    // The gateway already scrapes every Qdrant peer by name; an annotation
    // would send each series twice.
    expect(names.some((n) => n.includes("qdrant"))).toBe(false);
  });

  it("scrapes every Postgres instance and pooler, through the pods the operator builds", () => {
    const cluster = RESOURCES.find((r) => r.type.endsWith("postgresql.cnpg.io/v1:Cluster"))!.inputs;
    expect(cluster.spec.inheritedMetadata.annotations).toMatchObject({
      [SCRAPE_ANNOTATION.scrape]: "true",
      [SCRAPE_ANNOTATION.port]: "9187",
    });
    const pooler = RESOURCES.find((r) => r.type.endsWith("postgresql.cnpg.io/v1:Pooler"))!.inputs;
    expect(pooler.spec.template.metadata.annotations).toMatchObject({ [SCRAPE_ANNOTATION.port]: "9127" });
  });

  it("enables and annotates KEDA's operator metrics", () => {
    const keda = RESOURCES.find((r) => r.type === "kubernetes:helm.sh/v3:Release" && r.name === "keda")!.inputs;
    expect(keda.values.prometheus.operator).toEqual({ enabled: true, port: 8080 });
    expect(keda.values.podAnnotations.keda).toMatchObject({ [SCRAPE_ANNOTATION.port]: "8080" });
  });
});
