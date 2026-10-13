import { describe, it, expect, beforeAll, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";
import { DependencyGraph } from "./src/test-support/dependency-graph";

/**
 * The one-shot move of the retired Chroma store into Qdrant (ADR-0105), with
 * `chromaMigration` on: the whole program built once and the Job held to the
 * contract its two scripts were written against.
 *
 * Every value here plans clean and fails only on a cluster: a claim mounted
 * read-write is a Job that can damage the one copy of the Chroma data, a step
 * pointed at another path finds no export, a scratch emptyDir fills the node
 * and evicts its neighbours, an importer missing from `allow-app-to-qdrant`
 * times out on every call, and a Job created before the backend tiers rolled
 * reads a store an old pod is still writing.
 */

// The exporter is another change's file (`deploy/migration/chroma_export.py`);
// what this suite owns is that the Job ships whatever is at that path.
const EXPORTER = "# chroma_export.py under test\n";
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) =>
    String(path).endsWith("/deploy/migration/chroma_export.py")
      ? EXPORTER
      : (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof fs.readFileSync;
  return { ...fs, readFileSync, default: { ...fs, readFileSync } };
});

type Env = { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } };
type Mount = { name: string; mountPath: string; readOnly?: boolean };
type Container = {
  name: string;
  image: string;
  command: string[];
  env?: Env[];
  volumeMounts?: Mount[];
  securityContext?: Record<string, unknown>;
  resources?: { requests: Record<string, string>; limits: Record<string, string> };
};
type PodSpec = {
  restartPolicy: string;
  enableServiceLinks: boolean;
  securityContext: Record<string, unknown>;
  volumes: unknown[];
  initContainers: Container[];
  containers: Container[];
};
type JobInputs = {
  metadata: { name: string; annotations?: Record<string, string> };
  spec: { backoffLimit: number; ttlSecondsAfterFinished: number; template: { spec: PodSpec } };
};
type PolicyPeer = { podSelector: { matchLabels: Record<string, string> } };

const RESOURCES: Array<{ type: string; name: string; id?: string; inputs: Record<string, unknown> }> = [];
let graph: DependencyGraph;

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, id: args.id, inputs: args.inputs });
      return {
        id: args.id ?? `${args.name}-id`,
        state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } },
      };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

const JOB = "kubernetes:batch/v1:Job";
const find = (type: string, name: string) => {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  expect(hit, `${type} ${name}`).toBeDefined();
  return hit!;
};
const job = () => find(JOB, "chroma-migration").inputs as unknown as JobInputs;
const pod = () => job().spec.template.spec;
const step = (name: string): Container =>
  [...pod().initContainers, ...pod().containers].find((c) => c.name === name) as Container;
const envOf = (c: Container) => Object.fromEntries((c.env ?? []).map((e) => [e.name, e]));

describe("the Chroma migration Job, switched on", () => {
  beforeAll(async () => {
    graph = new DependencyGraph();
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:chromaMigration": "true" });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("ships the exporter from deploy/migration in a ConfigMap", () => {
    const cm = find("kubernetes:core/v1:ConfigMap", "chroma-migration-exporter").inputs as {
      data: Record<string, string>;
    };
    expect(cm.data).toEqual({ "chroma_export.py": EXPORTER });
  });

  it("reads the retained claim and never manages it", () => {
    // A read: Pulumi drops it from state without touching the object, so no
    // later `up` can delete the claim. A managed claim resource could be.
    const claim = find("kubernetes:core/v1:PersistentVolumeClaim", "chroma-migration-claim");
    expect(claim.id).toBe("grid/data-chroma-0");
  });

  it("mounts the old Chroma claim read-only, and nothing else of it", () => {
    expect(pod().volumes).toContainEqual({
      name: "chroma",
      persistentVolumeClaim: { claimName: "data-chroma-0", readOnly: true },
    });
    const mounting = [...pod().initContainers, ...pod().containers].filter((c) =>
      (c.volumeMounts ?? []).some((m) => m.name === "chroma"),
    );
    expect(mounting.map((c) => c.name)).toEqual(["export"]);
    expect(step("export").volumeMounts).toContainEqual({ name: "chroma", mountPath: "/chroma", readOnly: true });
  });

  it("shares a scratch claim on the stack's StorageClass, sized by the knob, not the node's disk", () => {
    expect(pod().volumes).toContainEqual({
      name: "exchange",
      ephemeral: {
        volumeClaimTemplate: {
          metadata: { labels: expect.objectContaining({ "app.kubernetes.io/name": "chroma-migration" }) },
          spec: {
            accessModes: ["ReadWriteOnce"],
            storageClassName: "premium",
            resources: { requests: { storage: "50Gi" } },
          },
        },
      },
    });
    for (const c of [...pod().initContainers, ...pod().containers]) {
      expect(c.volumeMounts, c.name).toContainEqual({ name: "exchange", mountPath: "/exchange" });
    }
  });

  it("exports first, through uv so the chromadb the script pins is the one installed", () => {
    expect(pod().initContainers.map((c) => c.name)).toEqual(["export"]);
    const exporter = step("export");
    expect(exporter.image).toBe("ghcr.io/astral-sh/uv:0.11.32-python3.12-trixie-slim");
    expect(exporter.command.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(exporter.command[2].split("\n").at(-1)).toBe(
      "exec uv run --script /migration/chroma_export.py --persist-dir /chroma --out /exchange/export",
    );
    expect(exporter.volumeMounts).toContainEqual({ name: "migration", mountPath: "/migration", readOnly: true });
    // The root is read-only, so nothing the exporter or uv writes may land there.
    const env = envOf(exporter);
    expect(env.UV_CACHE_DIR.value).toBe("/exchange/uv-cache");
    expect(env.TMPDIR.value).toBe("/exchange/tmp");
    expect(env.HOME.value).toBe("/exchange/home");
    expect(env.UV_PYTHON_DOWNLOADS.value).toBe("never");
  });

  it("imports in the backend image with the backend's Qdrant URL and key, and verifies", () => {
    expect(pod().containers.map((c) => c.name)).toEqual(["import"]);
    const importer = step("import");
    expect(importer.image).toMatch(/aiq-agent|backend/);
    expect(importer.command).toEqual(["python", "scripts/import_vectors.py", "--in", "/exchange/export", "--verify"]);
    const env = envOf(importer);
    expect(env.AIQ_QDRANT_URL.value).toBe("http://qdrant.grid.svc.cluster.local:6333");
    expect(env.AIQ_QDRANT_API_KEY.valueFrom!.secretKeyRef).toEqual({ name: "grid-secrets", key: "AIQ_QDRANT_API_KEY" });
  });

  it("runs as a non-root user with no privilege, on read-only roots where the image allows", () => {
    expect(pod().securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
    });
    expect(pod().enableServiceLinks).toBe(false);
    for (const c of [...pod().initContainers, ...pod().containers]) {
      expect(c.securityContext, c.name).toMatchObject({
        allowPrivilegeEscalation: false,
        privileged: false,
        capabilities: { drop: ["ALL"] },
        seccompProfile: { type: "RuntimeDefault" },
      });
      expect(c.resources?.limits.memory, c.name).toBeDefined();
    }
    expect(step("export").securityContext).toMatchObject({ readOnlyRootFilesystem: true });
  });

  it("never lands beside a Chroma pod, so the claim cannot be read while a server holds it", () => {
    expect((pod() as PodSpec & { affinity: unknown }).affinity).toEqual({
      podAntiAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          {
            labelSelector: { matchLabels: { "app.kubernetes.io/name": "chroma" } },
            topologyKey: "kubernetes.io/hostname",
          },
        ],
      },
    });
  });

  // A later backend image would otherwise replace the Job and import again over
  // a store that has moved on, bringing deleted documents' chunks back.
  it("runs once: a later deploy never replaces it", () => {
    expect(graph.find(JOB, "chroma-migration").ignoreChanges).toEqual(["spec"]);
  });

  it("retries inside one pod, keeps its log for a week, and is not awaited by the deploy", () => {
    expect(pod().restartPolicy).toBe("OnFailure");
    expect(job().spec.backoffLimit).toBe(3);
    expect(job().spec.ttlSecondsAfterFinished).toBe(7 * 24 * 3600);
    expect(job().metadata.annotations).toEqual({ "pulumi.com/skipAwait": "true" });
  });

  it("starts only after every backend tier has rolled and Qdrant is up", () => {
    for (const [type, name] of [
      ["kubernetes:apps/v1:Deployment", "aiq-api"],
      ["kubernetes:apps/v1:StatefulSet", "aiq-agent"],
      ["kubernetes:apps/v1:Deployment", "agent-worker"],
      ["kubernetes:apps/v1:Deployment", "ingest-worker"],
      ["kubernetes:core/v1:Service", "qdrant"],
      ["kubernetes:core/v1:ConfigMap", "chroma-migration-exporter"],
    ]) {
      expect(graph.waitsOn(JOB, "chroma-migration", type, name), name).toBe(true);
    }
    expect(graph.find(JOB, "chroma-migration").dependencies).toContain(
      "urn:pulumi:test::grid-oib::kubernetes:core/v1:PersistentVolumeClaim::chroma-migration-claim",
    );
  });

  it("is a named caller of Qdrant's client ports", () => {
    const policy = find("kubernetes:networking.k8s.io/v1:NetworkPolicy", "allow-app-to-qdrant").inputs as {
      spec: { ingress: Array<{ from: PolicyPeer[] }> };
    };
    const callers = policy.spec.ingress[0].from.map((f) => f.podSelector.matchLabels["app.kubernetes.io/name"]);
    expect(callers).toContain("chroma-migration");
  });
});
