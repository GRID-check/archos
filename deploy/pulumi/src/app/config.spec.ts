import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { purgerEnv, schedulerEnv, type AppWiring } from "./config";
import type { GridConfig } from "../config";

const here = __dirname;
// src/app -> src -> deploy/pulumi -> deploy -> repo root
const repoRoot = join(here, "..", "..", "..", "..");
// The whole worker, not just its entrypoint: the shared `workers/app-database.js`
// reads the DSN, and the point of this guard is to see every name the process consumes.
const schedulerDir = join(repoRoot, "frontends", "ui", "scheduler");
const schedulerSource = [
  ...readdirSync(schedulerDir)
    .filter((file) => file.endsWith(".js") && !file.endsWith(".spec.js"))
    .map((file) => readFileSync(join(schedulerDir, file), "utf8")),
  // The retention window is read by the shared Langfuse client the sweep uses.
  readFileSync(join(repoRoot, "frontends", "ui", "workers", "langfuse-traces.js"), "utf8"),
  readFileSync(join(repoRoot, "frontends", "ui", "workers", "app-database.js"), "utf8"),
].join("\n");
const configSource = readFileSync(join(here, "config.ts"), "utf8");

/** Every `env.GRID_*` / `process.env.GRID_*` the scheduler actually reads. */
function envNamesReadBy(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/(?:process\.)?env\.(GRID_[A-Z0-9_]+)/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

/**
 * The env names this program EMITS must be the names its consumers READ.
 *
 * This is the bug that shipped Agent Skills as an invisible feature. The
 * scheduler worker and the BFF moved to `GRID_SKILLS_ENABLED` /
 * `GRID_SKILL_SCHEDULER_*` when Workflows was replaced; this file kept emitting
 * `GRID_WORKFLOWS_ENABLED` / `GRID_WORKFLOW_SCHEDULER_*`, whose readers had been
 * deleted. Nothing failed: the stack planned clean, applied clean, every unit
 * suite on both sides passed, and the container started, read an unset start
 * gate and exited 0 exactly as designed. The only symptom was a user saying the
 * tab was not there.
 *
 * A name mismatch across a process boundary cannot be caught by testing either
 * side alone, which is why this test reads the consumer's source rather than a
 * list someone has to remember to update.
 */
/** The Secret reference of an env var whose value is a plain (non-Output) literal in this block. */
function secretRef(env: ReturnType<typeof schedulerEnv>, name: string) {
  const from = env.find((e) => e.name === name)?.valueFrom as
    | { secretKeyRef?: { name: string; key: string } }
    | undefined;
  return from?.secretKeyRef;
}

describe("schedulerEnv", () => {
  const cfg = {
    skills: { minIntervalMinutes: 15 },
    observability: { enabled: false },
    langfuse: { enabled: true },
  } as unknown as GridConfig;
  const env = schedulerEnv({ cfg } as unknown as AppWiring);
  // `EnvVar.name` is `Input<string>`; every entry in this block is a literal.
  const emitted = new Set(
    env.map((e) => e.name).filter((name): name is string => typeof name === "string"),
  );

  it("emits every GRID_ env var the scheduler reads", () => {
    const read = envNamesReadBy(schedulerSource);
    // Sanity: if the extraction stops finding anything, the assertion below
    // would pass vacuously and the guard would be silently dead.
    expect(read.length).toBeGreaterThan(3);
    expect([...read].filter((name) => !emitted.has(name))).toEqual([]);
  });

  it("emits no GRID_ var the scheduler does not read", () => {
    // The other half of the mismatch: a stale name left behind here is how the
    // block LOOKED correct while the gate it was supposed to set stayed unset.
    const read = new Set(envNamesReadBy(schedulerSource));
    const gridEmitted = [...emitted].filter((name) => name.startsWith("GRID_"));
    expect(gridEmitted.filter((name) => !read.has(name))).toEqual([]);
  });

  it("emits no feature switch: whether a schedule fires is the organization's flag", () => {
    // `GRID_SKILLS_ENABLED` / `GRID_ENFORCE_FEATURE_FLAGS` were the worker's
    // schedules gate; the BFF now checks the `skills` WorkOS flag per fire.
    expect(emitted.has("GRID_SKILLS_ENABLED")).toBe(false);
    expect(emitted.has("GRID_ENFORCE_FEATURE_FLAGS")).toBe(false);
  });

  it("gives the trace retention sweep Langfuse's API and a 30-day window when the tier is deployed", () => {
    expect(env.find((e) => e.name === "LANGFUSE_HOST")?.value).toBe("http://langfuse-web:3000");
    expect(env.find((e) => e.name === "GRID_LANGFUSE_TRACE_RETENTION_DAYS")?.value).toBe("30");
    expect(secretRef(env, "LANGFUSE_PUBLIC_KEY")).toEqual({ name: "langfuse-secrets", key: "public-key" });
    expect(secretRef(env, "LANGFUSE_SECRET_KEY")).toEqual({ name: "langfuse-secrets", key: "secret-key" });
  });

  it("emits nothing about Langfuse without the tier, so the sweep is its logged no-op", () => {
    const off = schedulerEnv({
      cfg: { ...cfg, langfuse: { enabled: false } },
    } as unknown as AppWiring);
    expect(off.filter((e) => /LANGFUSE/.test(String(e.name)))).toEqual([]);
  });
});

describe("purgerEnv", () => {
  const wiring = (langfuseEnabled: boolean) =>
    ({
      cfg: {
        observability: { enabled: false },
        seaweedfs: { accessKey: "a", bucket: "b" },
        langfuse: { enabled: langfuseEnabled },
      },
      seaweedInternalEndpoint: "http://seaweedfs:8333",
    }) as unknown as AppWiring;

  it("gives the purger Langfuse's API to delete an erased chat's traces", () => {
    const env = purgerEnv(wiring(true));
    expect(env.find((e) => e.name === "LANGFUSE_HOST")?.value).toBe("http://langfuse-web:3000");
    expect(secretRef(env, "LANGFUSE_PUBLIC_KEY")?.key).toBe("public-key");
    expect(secretRef(env, "LANGFUSE_SECRET_KEY")?.key).toBe("secret-key");
  });

  it("emits nothing about Langfuse without the tier", () => {
    expect(purgerEnv(wiring(false)).filter((e) => /LANGFUSE/.test(String(e.name)))).toEqual([]);
  });
});

describe("frontendEnv", () => {
  it("emits none of the retired feature switches", () => {
    // Every feature is a WorkOS flag per organization now
    // (`frontends/ui/src/lib/authz/feature-flags.ts`). An env switch emitted
    // here would read as a lever and move nothing, which is how
    // `GRID_WORKFLOWS_ENABLED` once shipped a feature with no way to turn it on.
    // Read from source rather than by calling frontendEnv: it touches most of
    // GridConfig, and a stub deep enough to call it would assert more about the
    // stub than about the program.
    for (const name of [
      "GRID_ENFORCE_FEATURE_FLAGS",
      "GRID_SKILLS_ENABLED",
      "GRID_COLLABORATION_ENABLED",
      "GRID_MAIL_IMPORT_ENABLED",
      "GRID_IFC_MODELS_ENABLED",
      "GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED",
      "GRID_MEMORY_REFLECTION_ENABLED",
      "GRID_WORKFLOWS_ENABLED",
    ]) {
      expect(configSource).not.toContain(`name: "${name}"`);
    }
  });
});

/**
 * Extraction is on because the CODE says so, not because a deployment
 * remembered a flag. Production once set only AIQ_EXTRACT_IMAGES: uncaptioned
 * tables were indexed as garbled page text, and every raster the VLM typed as a
 * chart was analysed, paid for, and dropped. The rule is now "no flag set in a
 * deployment = on", which holds only while the adapter reads each flag as an
 * off-switch. Both halves are checked here, across the process boundary.
 */
describe("backendEnv extraction switches", () => {
  const adapterSource = readFileSync(
    join(repoRoot, "sources", "knowledge_layer", "src", "llamaindex", "adapter.py"),
    "utf8",
  );
  const switches = ["AIQ_EXTRACT_TABLES", "AIQ_EXTRACT_IMAGES", "AIQ_EXTRACT_CHARTS"];

  it("sets none of them, so none can be left off by omission", () => {
    for (const name of switches) {
      expect(configSource).not.toContain(`"${name}"`);
    }
  });

  it("relies on the adapter reading each as on-unless-false", () => {
    for (const name of switches) {
      expect(adapterSource).toContain(`_env_switch("${name}")`);
    }
  });
});

/** The source of one exported env builder, up to the next export. */
function builderSource(name: string): string {
  const start = configSource.indexOf(`export function ${name}(`);
  const end = configSource.indexOf("\nexport function ", start + 1);
  return configSource.slice(start, end === -1 ? undefined : end);
}

describe("one OpenRouter key per organization (ADR-0121)", () => {
  const orgKeysSource = readFileSync(
    join(repoRoot, "frontends", "ui", "src", "lib", "llm-credentials", "org-keys.ts"),
    "utf8",
  );

  it("hands the BFF the management key under the names the BFF reads", () => {
    for (const name of ["OPENROUTER_MANAGEMENT_KEY", "OPENROUTER_ORG_KEY_MONTHLY_LIMIT_USD"]) {
      expect(orgKeysSource).toContain(`'${name}'`);
      expect(builderSource("frontendEnv")).toContain(`"${name}"`);
    }
    expect(builderSource("frontendEnv")).toContain('sref("OPENROUTER_MANAGEMENT_KEY")');
  });

  it("never gives the management key to the backend, which only ever needs an organization's key", () => {
    for (const builder of ["backendEnv", "chatEnv", "apiEnv", "workerEnv", "ingestWorkerEnv"]) {
      expect(builderSource(builder)).not.toContain("OPENROUTER_MANAGEMENT_KEY");
    }
  });
});
