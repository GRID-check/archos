import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig, langfuseStackConfig } from "../test-support/stack-config";

/**
 * Every collector config the program can render, run through the collector's
 * own `validate` command.
 *
 * The other collector specs hold the config to what we meant. This holds it to
 * what the collector accepts: a component id that does not exist in the
 * pinned build, a key a receiver does not know, a pipeline naming an exporter
 * nobody declared. Each of those stops the collector from starting, and with
 * it every export in the cluster, and none of them fails a plan.
 *
 * Needs `OTELCOL_BIN`, the `otelcol-contrib` binary of the version the image
 * digest in `config/observability.ts` pins; CI's infra job installs it. Without it the suite
 * is reported as skipped.
 */

const OTELCOL_BIN = process.env.OTELCOL_BIN;

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

/** Every `collector.yaml` the program renders for one stack, by ConfigMap name. */
async function renderedConfigs(values: Record<string, string>): Promise<Record<string, string>> {
  vi.resetModules();
  RESOURCES.length = 0;
  pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...values });
  await import("../../index");
  await new Promise((r) => setTimeout(r, 200));
  const configs: Record<string, string> = {};
  for (const r of RESOURCES.filter((r) => r.type === "kubernetes:core/v1:ConfigMap")) {
    const data = await resolve<Record<string, string> | undefined>(r.inputs.data);
    if (data?.["collector.yaml"]) configs[r.name] = data["collector.yaml"];
  }
  return configs;
}

/**
 * The config as it reads outside a pod. `validate` builds every receiver, and
 * kubelet_stats reads the pod's service account certificate while it does; a
 * CI runner has none. That identity is the one thing swapped, and only it:
 * every other key still reaches the build.
 */
function outsideThePod(yaml: string): string {
  return yaml.split("auth_type: serviceAccount").join("auth_type: none");
}

const STACKS: Record<string, Record<string, string>> = {
  "the defaults (PostHog on, Qdrant on)": {},
  "Langfuse and PostHog both on": langfuseStackConfig(),
  "Langfuse with PostHog opted out": { ...langfuseStackConfig(), "grid-oib:posthogHost": "" },
};

describe.skipIf(!OTELCOL_BIN)("every rendered collector config passes `otelcol-contrib validate`", () => {
  const rendered: Array<[string, string, string]> = [];

  beforeAll(async () => {
    for (const [stack, values] of Object.entries(STACKS)) {
      for (const [name, yaml] of Object.entries(await renderedConfigs(values))) rendered.push([stack, name, yaml]);
    }
  }, 240_000);

  it("renders at least one config per stack", () => {
    expect(new Set(rendered.map(([stack]) => stack))).toEqual(new Set(Object.keys(STACKS)));
  });

  it("is accepted by the pinned collector build", () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-validate-"));
    const failures: string[] = [];
    for (const [index, [stack, name, yaml]] of rendered.entries()) {
      const file = join(dir, `${index}-${name}.yaml`);
      writeFileSync(file, outsideThePod(yaml));
      try {
        // `${env:…}` references must resolve for validate to load the file;
        // the values are placeholders, the shape is what is under test.
        execFileSync(OTELCOL_BIN!, ["validate", `--config=${file}`], {
          env: { ...process.env, LANGFUSE_OTLP_AUTH: "Basic placeholder", K8S_NODE_NAME: "node-0" },
          stdio: "pipe",
        });
      } catch (error) {
        const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
        failures.push(`${stack} / ${name}:\n${stderr}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
