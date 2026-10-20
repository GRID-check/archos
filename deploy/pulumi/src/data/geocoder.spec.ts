import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * The geocoder (ADR-0120): Photon over the Austrian extract, behind the
 * project dialog's address search.
 *
 * What a green plan would hide here:
 *   - A frontend left without `GRID_GEOCODER_URL`, or pointed somewhere other
 *     than the in-cluster Service, works: the dialog silently falls back to a
 *     plain text field, or sends every typed address out of the cluster.
 *   - A pod any workload may call, or one that may dial anything, holds every
 *     address a person types.
 *   - The init script is a string. A wrong `tar` flag or a swap in the wrong
 *     order deletes a working index on a failed refresh, and only shows when
 *     the download server is down. It is run below, against a local server.
 */

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, any> }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return {
        id: `${args.name}-id`,
        state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } },
      };
    },
    call: () => ({}),
  },
  "grid-oib",
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

const NETPOL = "kubernetes:networking.k8s.io/v1:NetworkPolicy";
const STS = "kubernetes:apps/v1:StatefulSet";
type EnvVar = k8s.types.input.core.v1.EnvVar;

/** "3Gi" / "1536Mi" / "1g" → MiB. */
function mib(quantity: string): number {
  const m = /^(\d+)(Gi|Mi|g|m)$/.exec(quantity);
  if (!m) throw new Error(`unparsed quantity ${quantity}`);
  return Number(m[1]) * (m[2] === "Gi" || m[2] === "g" ? 1024 : 1);
}

describe("geocoder", () => {
  let env: EnvVar[] = [];
  let envDisabled: EnvVar[] = [];
  let bffJobsEnv: EnvVar[] = [];
  let defaults: Awaited<ReturnType<typeof import("../config")["loadConfig"]>> = undefined as never;

  beforeAll(async () => {
    const { loadConfig } = await import("../config");
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:observabilityEnabled": "false" });
    defaults = loadConfig();
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:observabilityEnabled": "false",
      "grid-oib:geocoderEnabled": "true",
    });
    const cfg = loadConfig();
    const { installGeocoder } = await import("./geocoder");
    const { installNetworkPolicies } = await import("../platform/network-policies");
    const appConfig = await import("../app/config");
    const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
    const g = installGeocoder(cfg, provider, "grid", []);
    installNetworkPolicies(cfg, provider, "grid");
    const wiring = {
      cfg,
      namespace: "grid",
      provider,
      redisUrl: pulumi.output("redis://dragonfly:6379"),
      seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
      seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
      qdrantUrl: pulumi.output("http://qdrant.grid.svc.cluster.local:6333"),
      dsn: () => pulumi.output("postgresql://x"),
      imagePullSecrets: [],
    };
    env = appConfig.frontendEnv({ ...wiring, geocoderUrl: g.url });
    envDisabled = appConfig.frontendEnv(wiring);
    bffJobsEnv = appConfig.bffJobsEnv({ ...wiring, geocoderUrl: g.url });
    await new Promise((done) => g.service.id.apply(done));
  });

  it("is off unless a stack turns it on", () => {
    expect(defaults.geocoder.enabled).toBe(false);
  });

  it("runs official images pinned by digest", () => {
    // This pod sees every address a person types; a moving tag is an
    // unreviewed upgrade of it.
    expect(defaults.geocoder.image).toMatch(/^eclipse-temurin:21[\w.-]*-jre-noble@sha256:[0-9a-f]{64}$/);
    expect(defaults.geocoder.fetchImage).toMatch(/^alpine:3\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });

  it("serves the pinned Photon jar on its port, from the volume, inside its memory limit", async () => {
    const { GEOCODER } = await import("../constants");
    const spec = await resolve(find(STS, "geocoder").inputs.spec);
    const pod = spec.template.spec;
    const photon = pod.containers[0];
    const fetch = pod.initContainers[0];

    expect(photon.command.slice(0, 3)).toEqual(["java", `-Xmx${GEOCODER.javaHeap}`, `-Xms${GEOCODER.javaHeap}`]);
    expect(photon.command).toEqual(
      expect.arrayContaining(["-jar", `/data/photon-${GEOCODER.photonVersion}.jar`, "serve"]),
    );
    const flag = (name: string) => photon.command[photon.command.indexOf(name) + 1];
    expect(flag("-listen-ip")).toBe("0.0.0.0");
    expect(flag("-listen-port")).toBe("2322");
    expect(flag("-data-dir")).toBe("/data/current");
    // The adapter asks for at most 2 × GEOCODE_MAX_LIMIT (8) hits.
    expect(Number(flag("-max-results"))).toBeGreaterThanOrEqual(16);
    // The heap plus the page cache the index is read through must fit.
    expect(mib(GEOCODER.javaHeap) * 2).toBeLessThanOrEqual(mib(photon.resources.limits.memory));

    for (const probe of [photon.startupProbe, photon.readinessProbe, photon.livenessProbe]) {
      expect(probe.httpGet).toEqual({ path: "/status", port: 2322 });
    }
    expect(photon.volumeMounts).toEqual([{ name: "data", mountPath: "/data" }]);
    expect(fetch.volumeMounts).toEqual([{ name: "data", mountPath: "/data" }]);

    const fetchEnv = Object.fromEntries(fetch.env.map((e: EnvVar) => [e.name, e.value]));
    expect(fetchEnv.JAR_URL).toBe(
      `https://github.com/komoot/photon/releases/download/${GEOCODER.photonVersion}/photon-${GEOCODER.photonVersion}.jar`,
    );
    expect(fetchEnv.JAR_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(fetchEnv.INDEX_URL).toMatch(/^https:\/\/download1\.graphhopper\.com\/.*austria-1\.0-latest\.tar\.bz2$/);
    expect(fetchEnv.INDEX_MAX_AGE_DAYS).toBe("30");

    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 });
    expect(spec.volumeClaimTemplates[0].spec).toMatchObject({
      storageClassName: "premium",
      resources: { requests: { storage: "10Gi" } },
    });
  });

  it("hands the frontend the Service's address, and only the frontend", async () => {
    const svc = await resolve(find("kubernetes:core/v1:Service", "geocoder").inputs.spec);
    expect(svc.ports[0].port).toBe(2322);

    const url = env.find((e) => e.name === "GRID_GEOCODER_URL");
    expect(await resolve(url?.value)).toBe("http://geocoder:2322");
    // Off means absent: `/api/geocode` answers `enabled: false`.
    expect(envDisabled.some((e) => e.name === "GRID_GEOCODER_URL")).toBe(false);
    // The pool inherits the frontend's environment, but the policy below does
    // not admit it.
    expect(bffJobsEnv.some((e) => e.name === "GRID_GEOCODER_URL")).toBe(false);
  });

  it("admits the frontend alone, and lets the pod out to DNS and HTTPS only", async () => {
    const pol = await resolve(find(NETPOL, "geocoder-frontend-only").inputs.spec);
    expect(pol.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(pol.ingress).toEqual([
      {
        from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "frontend" } } }],
        ports: [{ protocol: "TCP", port: 2322 }],
      },
    ]);
    const egressPorts = pol.egress.flatMap((rule: { ports: Array<{ port: number }>; to?: unknown }) => {
      expect(rule.to).toBeUndefined();
      return rule.ports.map((p) => p.port);
    });
    expect(egressPorts.sort()).toEqual([443, 53, 53]);

    // Allows are additive: left in the wholesale intra-namespace allow, any pod
    // could still call it.
    const intra = await resolve(find(NETPOL, "allow-same-namespace").inputs.spec);
    expect(intra.podSelector.matchExpressions[0].values).toContain("geocoder");
  });
});

/**
 * The init script, run for real against a local HTTP server. It needs `sh`,
 * `wget`, `tar` with bzip2 and `sha256sum`/`md5sum`: busybox on alpine in the
 * cluster, the host's tools here. Skipped where the host lacks one.
 */
const HOST_TOOLS = ["sh", "wget", "tar", "bzip2", "sha256sum", "md5sum"].every((tool) => {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

describe.skipIf(!HOST_TOOLS)("the geocoder's fetch script", () => {
  const run = promisify(execFile);
  const files = new Map<string, Buffer>();
  let server: Server;
  let base = "";
  let work = "";
  const jar = Buffer.from("not really a jar");
  const jarSha = createHash("sha256").update(jar).digest("hex");

  /** A tarball shaped like GraphHopper's: one `photon_data/` directory. */
  function index(marker: string): Buffer {
    const dir = mkdtempSync(join(work, "src-"));
    mkdirSync(join(dir, "photon_data"));
    writeFileSync(join(dir, "photon_data", "marker"), marker);
    execFileSync("tar", ["-cjf", join(dir, "out.tar.bz2"), "-C", dir, "photon_data"]);
    return readFileSync(join(dir, "out.tar.bz2"));
  }

  function publish(tarball: Buffer, md5 = createHash("md5").update(tarball).digest("hex")) {
    files.set("/index.tar.bz2", tarball);
    files.set("/index.tar.bz2.md5", Buffer.from(`${md5}  index.tar.bz2\n`));
  }

  async function fetchInto(data: string, overrides: Record<string, string> = {}) {
    const { fetchScript } = await import("./geocoder");
    // No proxy variables: wget would send the loopback request through them.
    const childEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      JAR_URL: `${base}/photon.jar`,
      JAR_SHA256: jarSha,
      INDEX_URL: `${base}/index.tar.bz2`,
      INDEX_MAX_AGE_DAYS: "30",
      ...overrides,
    };
    return run("sh", ["-c", fetchScript(data)], { env: childEnv }).then(
      (out) => ({ code: 0, ...out }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );
  }

  const marker = (data: string) => readFileSync(join(data, "current", "photon_data", "marker"), "utf8");

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "geocoder-fetch-"));
    files.set("/photon.jar", jar);
    server = createServer((req, res) => {
      const body = files.get(req.url ?? "");
      if (!body) return void res.writeHead(404).end();
      res.writeHead(200).end(body);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server?.close();
    rmSync(work, { recursive: true, force: true });
  });

  it("fetches the jar and the index into an empty volume", async () => {
    const data = mkdtempSync(join(work, "vol-"));
    publish(index("v1"));

    const result = await fetchInto(data);

    expect(result.code).toBe(0);
    expect(marker(data)).toBe("v1");
    expect(readFileSync(join(data, "photon-1.3.0.jar"))).toEqual(jar);
    // Nothing but the jar and the live index is left behind.
    expect(readdirSync(data).sort()).toEqual(["current", "photon-1.3.0.jar"]);
    expect(existsSync(join(data, "current", "index.tar.bz2"))).toBe(false);
  });

  it("keeps a fresh index, and replaces a stale one", async () => {
    const data = mkdtempSync(join(work, "vol-"));
    publish(index("v1"));
    await fetchInto(data);
    publish(index("v2"));

    await fetchInto(data);
    expect(marker(data)).toBe("v1");

    writeFileSync(join(data, "current", ".fetched-at"), "0\n");
    const result = await fetchInto(data);
    expect(result.code).toBe(0);
    expect(marker(data)).toBe("v2");
  });

  it("serves the old index when a refresh fails its checksum", async () => {
    const data = mkdtempSync(join(work, "vol-"));
    publish(index("v1"));
    await fetchInto(data);
    writeFileSync(join(data, "current", ".fetched-at"), "0\n");
    publish(index("v2"), "0".repeat(32));

    const result = await fetchInto(data);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("serving the previous index");
    expect(marker(data)).toBe("v1");
    expect(existsSync(join(data, "next"))).toBe(false);
  });

  it("fails the pod when there is no index and none can be fetched", async () => {
    const data = mkdtempSync(join(work, "vol-"));

    const result = await fetchInto(data, { INDEX_URL: `${base}/missing.tar.bz2` });

    expect(result.code).not.toBe(0);
    expect(existsSync(join(data, "current"))).toBe(false);
  });

  it("refuses a jar whose sha256 is not the pinned one", async () => {
    const data = mkdtempSync(join(work, "vol-"));
    publish(index("v1"));

    const result = await fetchInto(data, { JAR_SHA256: "0".repeat(64) });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("sha256 mismatch");
    expect(readdirSync(data)).toEqual([]);
  });
});
