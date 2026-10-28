import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { LEGACY_PROJECT } from "./src/names";
import { baseStackConfig, langfuseStackConfig } from "./src/test-support/stack-config";

/**
 * Every Secret or ConfigMap key a pod asks for exists in the object the program
 * creates (the 2026-10 incident).
 *
 * A `secretKeyRef` to a key the Secret lacks is not a plan error, and Pulumi's
 * await does not catch it: the pod sits in `CreateContainerConfigError`
 * (`couldn't find key … in Secret …`) while the rest of the update goes green.
 * `bff-jobs`, `purger` and `skill-scheduler` waited eight days on a renamed
 * database URL key that way. This builds the whole program and checks
 * each reference of every pod template (Deployment, StatefulSet, DaemonSet, Job,
 * CronJob, Pod, init containers too) against the keys the program puts there.
 *
 * Out of scope on purpose: a reference marked `optional`, and an object some
 * other controller writes (`EXTERNAL`). Keys that come from ESC reach the
 * program as stack config and are written into a Secret by it, so they are
 * checked like the rest.
 */

type Ref = { name?: string; key?: string; optional?: boolean };
type EnvVar = {
  name: string;
  valueFrom?: { secretKeyRef?: Ref; configMapKeyRef?: Ref };
};
type Container = {
  name: string;
  env?: EnvVar[];
  envFrom?: Array<{ secretRef?: Ref; configMapRef?: Ref }>;
};
type Volume = {
  name: string;
  secret?: { secretName?: string; optional?: boolean; items?: Array<{ key: string }> };
  configMap?: { name?: string; optional?: boolean; items?: Array<{ key: string }> };
};
type PodSpec = { containers?: Container[]; initContainers?: Container[]; volumes?: Volume[] };
type Inputs = {
  metadata?: { name?: string; namespace?: string };
  data?: Record<string, unknown>;
  stringData?: Record<string, unknown>;
  binaryData?: Record<string, unknown>;
  spec?: {
    template?: { spec?: PodSpec };
    jobTemplate?: { spec?: { template?: { spec?: PodSpec } } };
    containers?: Container[];
    initContainers?: Container[];
    volumes?: Volume[];
  };
};

const RESOURCES: Array<{ type: string; name: string; inputs: Inputs }> = [];

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

/**
 * Objects other controllers write, and the keys they promise: CloudNativePG's
 * `<cluster>-superuser` and `<cluster>-app` Secrets, which the operator creates
 * once the Cluster is reconciled (`data/postgres-rename.ts` waits for it).
 */
const EXTERNAL: Record<string, string[]> = {};
const OPERATOR_SECRET = /-(superuser|app)$/;

const POD_TYPES = new Set([
  "kubernetes:apps/v1:Deployment",
  "kubernetes:apps/v1:StatefulSet",
  "kubernetes:apps/v1:DaemonSet",
  "kubernetes:batch/v1:Job",
  "kubernetes:batch/v1:CronJob",
  "kubernetes:core/v1:Pod",
]);

/** Pulumi marks a secret input in the mock as `{ <signature>: …, value: {…} }`; the keys are in `value`. */
const SECRET_SIGNATURE = "4dabf18193072939515e22adb298388d";
const unwrap = (m: Record<string, unknown> | undefined): Record<string, unknown> =>
  m && SECRET_SIGNATURE in m ? ((m.value as Record<string, unknown> | undefined) ?? {}) : (m ?? {});
const keysOf = (...maps: Array<Record<string, unknown> | undefined>): string[] => maps.flatMap((m) => Object.keys(unwrap(m)));

function podSpecOf(inputs: Inputs): PodSpec | undefined {
  return inputs.spec?.template?.spec ?? inputs.spec?.jobTemplate?.spec?.template?.spec ?? inputs.spec;
}

/** `Secret ns/app-secrets`: what the object is called where the kubelet looks it up. */
const idOf = (kind: "Secret" | "ConfigMap", namespace: string | undefined, name: string) =>
  `${kind} ${namespace ?? "?"}/${name}`;

interface Wanted {
  by: string;
  kind: "Secret" | "ConfigMap";
  namespace?: string;
  name?: string;
  key?: string;
}

function wantedBy(owner: string, namespace: string | undefined, pod: PodSpec): Wanted[] {
  const out: Wanted[] = [];
  for (const c of [...(pod.containers ?? []), ...(pod.initContainers ?? [])]) {
    const by = `${owner} container ${c.name}`;
    for (const e of c.env ?? []) {
      const s = e.valueFrom?.secretKeyRef;
      const m = e.valueFrom?.configMapKeyRef;
      if (s && !s.optional) out.push({ by: `${by} env ${e.name}`, kind: "Secret", namespace, name: s.name, key: s.key });
      if (m && !m.optional) out.push({ by: `${by} env ${e.name}`, kind: "ConfigMap", namespace, name: m.name, key: m.key });
    }
    for (const f of c.envFrom ?? []) {
      if (f.secretRef && !f.secretRef.optional) out.push({ by: `${by} envFrom`, kind: "Secret", namespace, name: f.secretRef.name });
      if (f.configMapRef && !f.configMapRef.optional) out.push({ by: `${by} envFrom`, kind: "ConfigMap", namespace, name: f.configMapRef.name });
    }
  }
  for (const v of pod.volumes ?? []) {
    const by = `${owner} volume ${v.name}`;
    if (v.secret && !v.secret.optional) {
      for (const item of v.secret.items ?? [{ key: undefined as unknown as string }])
        out.push({ by, kind: "Secret", namespace, name: v.secret.secretName, key: item.key });
    }
    if (v.configMap && !v.configMap.optional) {
      for (const item of v.configMap.items ?? [{ key: undefined as unknown as string }])
        out.push({ by, kind: "ConfigMap", namespace, name: v.configMap.name, key: item.key });
    }
  }
  return out;
}

/** What the program provides, by object: its name, and the keys it writes. */
function provided(resources: typeof RESOURCES): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of resources) {
    const kind = r.type === "kubernetes:core/v1:Secret" ? "Secret" : r.type === "kubernetes:core/v1:ConfigMap" ? "ConfigMap" : undefined;
    if (!kind) continue;
    const id = idOf(kind, r.inputs.metadata?.namespace, r.inputs.metadata?.name ?? r.name);
    const keys = out.get(id) ?? new Set<string>();
    for (const k of keysOf(r.inputs.data, r.inputs.stringData, r.inputs.binaryData)) keys.add(k);
    out.set(id, keys);
  }
  return out;
}

function unresolved(resources: typeof RESOURCES, everything: typeof RESOURCES = resources): string[] {
  const have = provided(everything);
  const problems: string[] = [];
  for (const r of resources.filter((x) => POD_TYPES.has(x.type))) {
    const pod = podSpecOf(r.inputs);
    if (!pod) continue;
    const owner = `${r.type.split(":").pop()} ${r.inputs.metadata?.name ?? r.name}`;
    for (const w of wantedBy(owner, r.inputs.metadata?.namespace, pod)) {
      if (typeof w.name !== "string") continue; // an Output the mock could not resolve: not checkable here
      const keys = have.get(idOf(w.kind, w.namespace, w.name));
      if (!keys) {
        if (w.kind === "Secret" && (OPERATOR_SECRET.test(w.name) || EXTERNAL[w.name])) continue;
        problems.push(`${w.by}: ${idOf(w.kind, w.namespace, w.name)} is not created by the program`);
      } else if (w.key !== undefined && !keys.has(w.key)) {
        problems.push(`${w.by}: couldn't find key ${w.key} in ${idOf(w.kind, w.namespace, w.name)} (it has: ${[...keys].sort().join(", ")})`);
      }
    }
  }
  return problems.sort();
}

describe("every Secret and ConfigMap key a pod reads is one the program writes", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      ...langfuseStackConfig(),
      [`${LEGACY_PROJECT}:qdrantDashboardEnabled`]: "true",
      [`${LEGACY_PROJECT}:pgBackupsEnabled`]: "true",
      [`${LEGACY_PROJECT}:requireAuth`]: "true",
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("builds pods that read Secrets, or this spec checks nothing", () => {
    const refs = RESOURCES.filter((r) => POD_TYPES.has(r.type)).flatMap((r) => {
      const pod = podSpecOf(r.inputs);
      return pod ? wantedBy(String(r.name), r.inputs.metadata?.namespace, pod) : [];
    });
    expect(refs.filter((w) => w.kind === "Secret" && w.key).length).toBeGreaterThan(20);
    expect(refs.filter((w) => w.kind === "ConfigMap").length).toBeGreaterThan(0);
  });

  it("resolves each reference to an object and key the program creates", () => {
    expect(unresolved(RESOURCES)).toEqual([]);
  });

  it("names the pod and the key when one is stale", () => {
    const stale: typeof RESOURCES = [
      { type: "kubernetes:core/v1:Secret", name: "s", inputs: { metadata: { name: "app-secrets", namespace: "ns" }, stringData: { APP_DATABASE_URL: "x" } } },
      {
        type: "kubernetes:apps/v1:Deployment",
        name: "purger",
        inputs: {
          metadata: { name: "purger", namespace: "ns" },
          spec: {
            template: {
              spec: {
                containers: [
                  { name: "purger", env: [{ name: "OLD_DATABASE_URL", valueFrom: { secretKeyRef: { name: "app-secrets", key: "OLD_DATABASE_URL" } } }] },
                ],
              },
            },
          },
        },
      },
    ];
    expect(unresolved(stale)).toEqual([
      "Deployment purger container purger env OLD_DATABASE_URL: couldn't find key OLD_DATABASE_URL in Secret ns/app-secrets (it has: APP_DATABASE_URL)",
    ]);
  });
});
