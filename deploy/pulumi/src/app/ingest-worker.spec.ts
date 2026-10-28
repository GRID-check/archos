import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { QUEUE_DEPTH_QUERY } from "./ingest-worker";
import { baseStackConfig } from "../test-support/stack-config";

// src/app -> src -> deploy/pulumi -> deploy -> repo root
const repoRoot = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

// The program's own resolved config, not a regex over the file next door: the
// default lives in `src/config.ts`, the env wiring in `src/app/config.ts`.
pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.name}-id`,
      state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } },
    }),
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

async function load() {
  pulumi.runtime.setAllConfig({
    ...baseStackConfig(),
    "grid-oib:observabilityEnabled": "false",
  });
  return import("../config").then((m) => m.loadConfig());
}

const pythonSources = [
  read("apps", "backend", "src", "agent_host", "jobs", "ingest_dispatch.py"),
  read("apps", "backend", "src", "agent_host", "jobs", "ingest_worker.py"),
  // The per-organisation cap is read where the in-process pool and the queue share it.
  read("packages", "agent", "src", "agent", "knowledge", "ingest_scheduler.py"),
  // The in-process pool's size, read by the knowledge layer's adapter.
  read("packages", "knowledge-layer", "src", "llamaindex", "adapter.py"),
].join("\n");
const configSource = read("deploy", "pulumi", "src", "app", "config.ts");

const names = (source: string, pattern: RegExp): Set<string> =>
  new Set([...source.matchAll(pattern)].map((m) => m[1]));

/**
 * The ingest tier crosses two process boundaries this program cannot see into:
 * the Python worker reads its env, and KEDA queries the Python queue's table.
 * A name that drifts on one side plans and applies clean, and the tier then
 * either never scales or claims nothing. Both sides are read here as source.
 */
describe("the ingest-worker tier", () => {
  it("emits only INGEST_ names the worker reads", () => {
    const readByPython = names(pythonSources, /"(INGEST_[A-Z_]+)"/g);
    const emitted = names(configSource, /name: "(INGEST_[A-Z_]+)"/g);
    expect(emitted.size).toBeGreaterThan(1);
    expect([...emitted].filter((n) => !readByPython.has(n))).toEqual([]);
  });

  it("scales on the table the queue actually writes", () => {
    const table = read("packages", "agent", "src", "agent", "knowledge", "ingest_queue.py").match(/^TABLE = "([a-z_]+)"$/m)?.[1];
    expect(table).toBeDefined();
    const dead = read("packages", "agent", "src", "agent", "common", "claim_queue.py").match(/^DEAD = "([a-z_]+)"$/m)?.[1];
    expect(dead).toBeDefined();
    const cancelled = read("packages", "agent", "src", "agent", "common", "claim_queue.py").match(
      /^CANCELLED = "([a-z_]+)"$/m,
    )?.[1];
    expect(cancelled).toBeDefined();
    // Retired rows (dead, cancelled) stay in the table as traces; they must not
    // keep replicas up.
    expect(QUEUE_DEPTH_QUERY).toBe(
      `SELECT COUNT(*) FROM ${table} WHERE status NOT IN ('${dead}', '${cancelled}')`,
    );
  });

  it("reads the queue through the one TriggerAuthentication both Python tiers share", () => {
    // The Secret key the scaler's DSN is in (`buildScalerSecret`): the tiers share
    // it because both queues live in one database.
    expect(configSource).toMatch(/JOBS_QUEUE_DSN_KEY = "KEDA_JOBS_QUEUE_DB_URL"/);
    expect(read("deploy", "pulumi", "src", "app", "ingest-worker.ts")).toContain("JOBS_QUEUE_AUTH");
  });

  it("runs prod wide and small on the batch group, never able to overcommit a node", () => {
    // Overcommitted limits took the 16 GB app nodes down one after another
    // (2026-10). The rule that prevents it, not just today's numbers: memory
    // request equals limit, so the scheduler places only what a node holds,
    // and every replica at its limit fits one 64 GB batch node (56 GiB: the
    // node less the kubelet reserve and Gotenberg, which shares the group).
    const prod = read("deploy", "pulumi", "Pulumi.prod.yaml");
    const knob = (key: string) => prod.match(new RegExp(`^\\s*grid-oib:${key}: "?([^"\\s]+)"?\\s*$`, "m"))?.[1];
    const gib = (value: string | undefined) => Number(value?.replace(/Gi$/, ""));

    expect(knob("nodeGroupBatch")).toBe("batch");
    expect(knob("ingestWorkerMaxReplicas")).toBe("8");
    expect(knob("ingestWorkerConcurrency")).toBe("2");
    expect(knob("ingestWorkerRequestsMemory")).toBe(knob("ingestWorkerLimitsMemory"));
    expect(Number(knob("ingestWorkerMaxReplicas")) * gib(knob("ingestWorkerLimitsMemory"))).toBeLessThanOrEqual(56);
  });

  it("runs the role the entrypoint knows", () => {
    expect(read("apps", "backend", "entrypoint.py")).toContain('role == "ingest-worker"');
    expect(configSource).toContain('{ name: "PROCESS_ROLE", value: "ingest-worker" }');
  });

  it("states the raster pixel budget the Python module defaults to", async () => {
    // Two sides, one number: a drift here either refuses a real plan scan or
    // lets one decode grow past the pod's limit. The Python side is read as
    // source, the Pulumi side from the loaded config, like the provider-budget
    // tests' `cfg.providerLimits`.
    const cfg = await load();
    const python = read("packages", "knowledge-layer", "src", "llamaindex", "adapter.py").match(
      /MAX_IMAGE_PIXELS = env_int\("MAX_IMAGE_PIXELS", ([\d_]+)/,
    )?.[1];
    expect(python).toBeDefined();
    expect(cfg.ingestWorker.maxImagePixels).toBe(Number(python!.replace(/_/g, "")));
    expect(configSource).toContain(
      '{ name: "MAX_IMAGE_PIXELS", value: String(w.cfg.ingestWorker.maxImagePixels) }',
    );
  });
});
