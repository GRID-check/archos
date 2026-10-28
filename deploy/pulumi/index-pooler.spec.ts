import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { POOLED_POOLS } from "./src/constants";
import { baseStackConfig, langfuseStackConfig } from "./src/test-support/stack-config";

/**
 * Postgres connections go through a transaction pooler, and every session
 * feature takes a direct connection (ADR-0083). This is the confirmation for
 * both halves, against the whole program rather than one module, because the
 * routing is spread across seven files and no one of them sees the table.
 *
 * The failure it exists to catch is silent. A session advisory lock taken
 * through a transaction pooler "works": the lock is acquired on one server
 * connection and released on another, and the first stays locked until it is
 * recycled. LISTEN through one registers on a server connection the client does
 * not keep, and no notification ever arrives. Neither raises an error.
 *
 * In the split topology with Langfuse on, so every consumer of a DSN is built:
 * the filer's store, Langfuse's Prisma, KEDA's two scaler DSNs.
 */

type Inputs = Record<string, unknown>;
const RESOURCES: Array<{ type: string; name: string; inputs: Inputs }> = [];

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

const NAMESPACE = "grid";
const DIRECT = "grid-pg-rw";
const POOLER = "grid-pg-pooler-rw";
const KEDA_DIRECT = `${DIRECT}.${NAMESPACE}.svc.cluster.local`;

/**
 * The route of every Postgres DSN the program emits, by `<resource>/<key>`.
 * A new DSN that is not in this table fails the test below, so choosing a route
 * is not something a new consumer can skip.
 */
const EXPECTED_HOSTS: Record<string, string> = {
  // The pooled five: self-contained per transaction.
  "grid-secrets/NAT_JOB_STORE_DB_URL": POOLER,  // pragma: allowlist secret
  "grid-secrets/CHECKPOINT_DB": POOLER,  // pragma: allowlist secret
  "grid-secrets/DEEP_CHECKPOINT_DB": POOLER,
  "grid-secrets/SUMMARY_DB": POOLER,
  "grid-secrets/APP_DATABASE_URL": POOLER,
  // Session-scoped: LISTEN/NOTIFY, session advisory locks, DDL under the owner.
  "grid-secrets/LISTEN_DB_URL": DIRECT,
  "grid-secrets/LOCK_DB_URL": DIRECT,
  "grid-secrets/APP_MIGRATION_DATABASE_URL": DIRECT,
  // KEDA polls from another namespace, so by FQDN, and straight to the primary.
  "grid-keda-scaler/KEDA_JOBS_QUEUE_DB_URL": KEDA_DIRECT,
  "grid-keda-scaler/KEDA_BFF_QUEUE_DB_URL": KEDA_DIRECT,
  // The init and grants Jobs.
  "pg-init-dsns/JOBS_DSN": DIRECT,
  "pg-init-dsns/CHECKPOINTS_DSN": DIRECT,
  "pg-init-dsns/SEAWEED_FILER_DSN": DIRECT,
  "keda-scaler-grants-dsns/JOBS_DSN": DIRECT,
  "keda-scaler-grants-dsns/APP_DSN": DIRECT,
  "keda-scaler-grants-dsns/NAT_JOB_STORE_DB_URL": DIRECT,  // pragma: allowlist secret
  "keda-scaler-grants-dsns/SUMMARY_DB": DIRECT,
  // Prisma migrates under a session advisory lock of its own.
  "langfuse-secrets/database-url": DIRECT,
};

/**
 * A Secret's `stringData` as the mock receives it: any value that is a pulumi
 * secret arrives wrapped as `{ <secret sigil>: ..., value }`, and a Secret
 * built from secret Outputs is wrapped whole.
 */
function unsecret(stringData: unknown): Record<string, unknown> {
  const wrapped = stringData as { value?: Record<string, unknown> } | undefined;
  return (wrapped && "value" in wrapped ? wrapped.value : (stringData as Record<string, unknown>)) ?? {};
}

/** Every `<resource>/<key>` whose value is a Postgres URL, with the URL parsed. */
function postgresDsns(): Array<{ id: string; url: URL }> {
  const found: Array<{ id: string; url: URL }> = [];
  for (const resource of RESOURCES) {
    if (resource.type !== "kubernetes:core/v1:Secret") continue;
    const data = unsecret(resource.inputs.stringData);
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== "string" || !/^postgres(ql)?(\+\w+)?:\/\//.test(value)) continue;
      // `new URL` does not know the `postgresql+asyncpg` scheme's authority rules.
      found.push({ id: `${resource.name}/${key}`, url: new URL(value.replace(/^postgres(ql)?(\+\w+)?:/, "postgres:")) });
    }
  }
  return found;
}

describe("Postgres routing", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      ...langfuseStackConfig(),
      "grid-oib:seaweedfsTopology": "split",
      "grid-oib:seaweedfsFilerStore": "postgres",
      "grid-oib:seaweedfsPerOrgBuckets": "true",
      "grid-oib:allowPlaintextJobPayloads": "true",
      "grid-oib:pgInstances": "3",
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("sends each DSN where the table says: pooled ones to the pooler, session ones to the primary", () => {
    const actual = Object.fromEntries(postgresDsns().map(({ id, url }) => [id, url.hostname]));

    expect(actual).toEqual(EXPECTED_HOSTS);
  });

  it("keeps LISTEN, the session locks and the migrations off the pooler, whatever else moves", () => {
    // The same fact as the table, stated as the rule it enforces, so a reviewer
    // reading a failure sees the reason and not only a diff of hostnames.
    const hosts = Object.fromEntries(postgresDsns().map(({ id, url }) => [id, url.hostname]));

    for (const key of ["LISTEN_DB_URL", "LOCK_DB_URL", "APP_MIGRATION_DATABASE_URL"]) {
      expect(hosts[`grid-secrets/${key}`], key).toBe(DIRECT);
    }
  });

  it("points LOCK_DB_URL at the jobs database as the owner, like the other Python DSNs", () => {
    const lock = postgresDsns().find(({ id }) => id === "grid-secrets/LOCK_DB_URL")!.url;
    const listen = postgresDsns().find(({ id }) => id === "grid-secrets/LISTEN_DB_URL")!.url;

    expect(lock.pathname).toBe("/jobs");
    expect(lock.username).toBe(listen.username);
    expect(lock.port).toBe("5432");
  });

  it("reads the filer's store from the primary", () => {
    const filer = RESOURCES.map((r) => JSON.stringify(r.inputs)).find((json) => json.includes("[postgres2]"));

    expect(filer, "a resource carrying filer.toml").toBeDefined();
    expect(filer).toContain(`hostname = \\"${DIRECT}\\"`);
    expect(filer).not.toContain(POOLER);
  });

  it("pools exactly the (database, role) pairs the connection budget pays for", () => {
    const pooled = postgresDsns().filter(({ url }) => url.hostname === POOLER);
    const pairs = new Set(pooled.map(({ url }) => `${url.pathname.slice(1)}/${decodeURIComponent(url.username)}`));
    const budgeted = new Set(
      POOLED_POOLS.map(({ database, login }) => `${database}/${login === "app" ? "agent" : "grid_app_rw"}`),
    );

    expect(pairs).toEqual(budgeted);
  });

  // `require_direct_dsns` refuses to start a Postgres process without them: the api role
  // needs both (it serves the job SSE streams), the chat role and the workers the lock DSN.
  // A tier left without one does not degrade, it crash-loops, so the manifest is held to it
  // here. The chat role is given the LISTEN DSN too, as it shares the env list with api.
  it("gives every pod that runs the Python code the direct DSNs its start-up check requires", () => {
    const env = (name: string) =>
      RESOURCES.filter(
        (r) =>
          (r.type === "kubernetes:apps/v1:Deployment" || r.type === "kubernetes:apps/v1:StatefulSet") &&
          r.name === name,
      ).flatMap((r) => {
        const spec = r.inputs.spec as { template: { spec: { containers: Array<{ env?: Array<{ name: string }> }> } } };
        return spec.template.spec.containers.flatMap((c) => (c.env ?? []).map((e) => e.name));
      });

    for (const tier of ["aiq-agent", "aiq-api", "agent-worker", "ingest-worker"]) {
      const names = env(tier);
      expect(names, `${tier} has env`).toContain("LISTEN_DB_URL");
      expect(names, `${tier} takes its locks on the direct DSN`).toContain("LOCK_DB_URL");
    }
  });

  describe("the Cluster's server parameters", () => {
    const parameters = () => {
      const cluster = RESOURCES.find((r) => r.type === "kubernetes:postgresql.cnpg.io/v1:Cluster")!;
      return (cluster.inputs.spec as { postgresql: { parameters: Record<string, string> } }).postgresql.parameters;
    };

    it("finds a dead client in about two minutes, through TCP keepalives", () => {
      // A node that dies closes no TCP connection. With the OS default (7200 s
      // idle) the server kept such sessions, and their session advisory locks,
      // for 16 to 55 minutes in the 2026-10 incident. 60 + 6 x 10 s = 120 s.
      expect(parameters()).toMatchObject({
        tcp_keepalives_idle: "60",
        tcp_keepalives_interval: "10",
        tcp_keepalives_count: "6",
      });
    });

    it("ends a session left idle inside a transaction after ten minutes", () => {
      expect(parameters().idle_in_transaction_session_timeout).toBe("10min");
    });

    it("sets no statement or idle-session timeout: a session-lock holder is idle on purpose", () => {
      expect(parameters()).not.toHaveProperty("statement_timeout");
      expect(parameters()).not.toHaveProperty("idle_session_timeout");
    });

    it("keeps the connection ceiling the pooler budget is held to", () => {
      expect(parameters()).toMatchObject({ max_connections: "200", shared_buffers: "256MB" });
    });
  });

  describe("the Pooler", () => {
    const pooler = () => RESOURCES.find((r) => r.type === "kubernetes:postgresql.cnpg.io/v1:Pooler")!;
    const spec = () => pooler().inputs.spec as {
      cluster: { name: string };
      instances: number;
      type: string;
      pgbouncer: { poolMode: string; parameters: Record<string, string> };
      template: {
        metadata: { labels: Record<string, string> };
        spec: {
          containers: Array<{ name: string; image: string }>;
          topologySpreadConstraints: Array<{ labelSelector: { matchLabels: Record<string, string> } }>;
        };
      };
    };

    it("is one resource, named for the Service the pooled DSNs resolve", () => {
      expect(RESOURCES.filter((r) => r.type === "kubernetes:postgresql.cnpg.io/v1:Pooler")).toHaveLength(1);
      expect((pooler().inputs.metadata as { name: string }).name).toBe(POOLER);
    });

    it("pools the read-write primary in transaction mode", () => {
      expect(spec().cluster.name).toBe("grid-pg");
      expect(spec().type).toBe("rw");
      expect(spec().pgbouncer.poolMode).toBe("transaction");
    });

    it("lets psycopg3 and asyncpg keep their prepared statements, sizes the pools, and drops idle-in-transaction clients", () => {
      expect(spec().pgbouncer.parameters).toEqual({
        max_client_conn: "2000",
        default_pool_size: "12",
        max_prepared_statements: "200",
        // A client idle inside a transaction pins a server connection and its
        // locks; ten minutes, the server's own idle_in_transaction timeout.
        idle_transaction_timeout: "600",
      });
    });

    it("runs a digest-pinned PgBouncer, in the container the operator names pgbouncer", () => {
      const [container] = spec().template.spec.containers;

      expect(container.name).toBe("pgbouncer");
      expect(container.image).toMatch(/^ghcr\.io\/cloudnative-pg\/pgbouncer:\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/);
    });

    it("spreads two poolers across nodes and budgets a disruption for them", () => {
      expect(spec().instances).toBe(2);
      expect(spec().template.spec.topologySpreadConstraints).toHaveLength(1);
      const pdb = RESOURCES.find((r) => r.type === "kubernetes:policy/v1:PodDisruptionBudget" && r.name === POOLER);

      expect(pdb, "a PDB for the poolers").toBeDefined();
      const pdbSpec = pdb!.inputs.spec as { maxUnavailable: number; selector: { matchLabels: Record<string, string> } };
      expect(pdbSpec.maxUnavailable).toBe(1);
      // By the label the operator sets, not the template's: CloudNativePG
      // overwrites `app.kubernetes.io/name` and `managed-by` on the pods, so a
      // selector on the template's labels matched no pooler (2026-10-12).
      expect(pdbSpec.selector.matchLabels).toEqual({ "cnpg.io/poolerName": POOLER });
      expect(spec().template.spec.topologySpreadConstraints[0].labelSelector.matchLabels).toEqual({
        "cnpg.io/poolerName": POOLER,
      });
    });
  });
});
