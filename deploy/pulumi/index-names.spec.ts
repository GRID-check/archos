import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig, forProject, langfuseStackConfig } from "./src/test-support/stack-config";

/**
 * No infrastructure name the `workspace` project creates carries a brand
 * (ADR-0147). Not `grid`, the retired name, and not `piloti`, the current one.
 *
 * Checked on the whole program, not on the names table, because the table only
 * covers what someone remembered to put in it: a new module that types
 * `"grid-foo"` as a Secret name is caught here, in this project's run, while
 * the legacy project keeps creating the names its stack already has.
 *
 * What is checked: Pulumi logical names (URN segments), and every object's
 * `metadata.name`, `metadata.namespace`, label value and annotation key.
 * Not checked, each with its owner in ADR-0147: Postgres database and role
 * names, bucket names and SeaweedFS identities, env var and OTel service
 * names. Those sit in env values and SQL, which this spec does not read.
 */

type Meta = { name?: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
type Inputs = { metadata?: Meta; spec?: { template?: { metadata?: Meta }; jobTemplate?: { spec?: { template?: { metadata?: Meta } } } } };

const RESOURCES: Array<{ type: string; name: string; inputs: Inputs }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } } };
    },
    call: () => ({}),
  },
  "workspace",
  "test",
  false,
);

const BRAND = /grid|piloti/i;

/** Every name-shaped string one resource carries, labelled by where it sits. */
function namesOf(r: { name: string; inputs: Inputs }): Array<[string, string]> {
  const metas: Meta[] = [
    r.inputs.metadata,
    r.inputs.spec?.template?.metadata,
    r.inputs.spec?.jobTemplate?.spec?.template?.metadata,
  ].filter((m): m is Meta => m !== undefined);
  const out: Array<[string, string]> = [["logical name", r.name]];
  for (const m of metas) {
    if (typeof m.name === "string") out.push(["metadata.name", m.name]);
    if (typeof m.namespace === "string") out.push(["metadata.namespace", m.namespace]);
    for (const [k, v] of Object.entries(m.labels ?? {})) if (typeof v === "string") out.push([`label ${k}`, v]);
    for (const k of Object.keys(m.annotations ?? {})) out.push(["annotation key", k]);
  }
  return out;
}

describe("the workspace project names nothing after a brand", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig(
      forProject(
        {
          ...baseStackConfig(),
          ...langfuseStackConfig(),
          "grid-oib:otelOidcClientSecret": "otel-client-secret", // pragma: allowlist secret
          "grid-oib:qdrantDashboardEnabled": "true",
          "grid-oib:pgBackupsEnabled": "true",
          "grid-oib:requireAuth": "true",
        },
        "workspace",
      ),
    );
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("deploys into the namespace `workspace`", () => {
    const ns = RESOURCES.filter((r) => r.type === "kubernetes:core/v1:Namespace").map((r) => r.inputs.metadata?.name);
    expect(ns).toContain("workspace");
  });

  it("gives no logical name, object name, namespace, label value or annotation key a brand", () => {
    const offenders = RESOURCES.flatMap((r) =>
      namesOf(r)
        .filter(([, value]) => BRAND.test(value))
        .map(([where, value]) => `${r.type} ${r.name}: ${where} = ${value}`),
    );
    expect(offenders).toEqual([]);
  });
});
