/**
 * The PostgreSQL connection budget: every client's share against `max_connections`.
 */
import {
  KEDA_SCALER_CONNECTION_LIMIT,
  POOLED_POOLS,
  POSTGRES_DIRECT_RESERVE,
  POSTGRES_POOLER,
  POSTGRES_TUNING,
} from "../constants";
import type { GridConfig } from "../config";

/** What `pgConnectionBudget` adds up, with the parts named so a failure can say which one grew. */
export interface PgConnectionBudget {
  /** `max_connections` on the primary. */
  limit: number;
  /** PgBouncer's worst case: instances x pooled pairs x pool size, plus each instance's auth session. */
  pooled: number;
  /** The direct connections held back, by name (zero parts included, so the list is stable). */
  reserve: Array<{ name: string; connections: number }>;
  reserveTotal: number;
  total: number;
}

type PgBudgetInputs = Pick<GridConfig, "postgres" | "ingestWorker" | "langfuse" | "seaweedfs" | "bffJobs">;

/**
 * The most connections the primary can be asked for, in `max_connections` slots
 * (ADR-0083): every PgBouncer at its pool ceiling, plus the connections that
 * bypass it by design. PgBouncer keeps a server pool per (database, role), so
 * the pooled side is `instances x POOLED_POOLS x poolSize`; the direct side is
 * {@link POSTGRES_DIRECT_RESERVE}, each part bounded by what holds it.
 */
export function pgConnectionBudget(cfg: PgBudgetInputs): PgConnectionBudget {
  const { instances, poolSize } = cfg.postgres.pooler;
  const pooled = instances * (POOLED_POOLS.length * poolSize + POSTGRES_POOLER.authConnections);
  const filerOnPostgres = cfg.seaweedfs.topology === "split" && cfg.seaweedfs.filerStore === "postgres";
  const ingestJobsInFlight = cfg.ingestWorker.maxReplicas * cfg.ingestWorker.concurrency;
  const reserve = [
    { name: "superuser_reserved_connections", connections: POSTGRES_DIRECT_RESERVE.superuser },
    { name: "CloudNativePG (instance manager, exporter, backup)", connections: POSTGRES_DIRECT_RESERVE.cnpg },
    { name: "job SSE LISTEN streams", connections: POSTGRES_DIRECT_RESERVE.sseListen },
    {
      name: "session advisory locks (ingest jobs in flight + background)",
      connections: ingestJobsInFlight + POSTGRES_DIRECT_RESERVE.sessionLocksBackground,
    },
    { name: "migration and bootstrap Jobs", connections: POSTGRES_DIRECT_RESERVE.bootstrapJobs },
    { name: "KEDA scaler login", connections: KEDA_SCALER_CONNECTION_LIMIT },
    { name: "Langfuse (Prisma)", connections: cfg.langfuse.enabled ? POSTGRES_DIRECT_RESERVE.langfuse : 0 },
    {
      name: "SeaweedFS filer store",
      connections: filerOnPostgres ? cfg.seaweedfs.filerReplicas * POSTGRES_DIRECT_RESERVE.filerPerReplica : 0,
    },
  ];
  const reserveTotal = reserve.reduce((sum, part) => sum + part.connections, 0);
  return { limit: Number(POSTGRES_TUNING.maxConnections), pooled, reserve, reserveTotal, total: pooled + reserveTotal };
}

/**
 * Refuse a Postgres whose pooled and direct connections together can pass
 * `max_connections`. A primary that runs out of slots does not degrade: new
 * sessions get "too many clients" while the old ones keep running, so the first
 * thing to fail is whichever tier happens to reconnect, which is a deploy, a
 * failover, or a KEDA scale-out, never the moment someone changed a number. The
 * three knobs that feed it (`pgPoolerInstances`, `pgPoolerPoolSize`, the ingest
 * tier's size) are set in different places and none looks wrong alone.
 */
export function assertPgConnectionBudget(cfg: PgBudgetInputs): void {
  const budget = pgConnectionBudget(cfg);
  if (budget.total <= budget.limit) return;
  const { instances, poolSize } = cfg.postgres.pooler;
  const parts = budget.reserve.filter((part) => part.connections > 0).map((part) => `${part.name} ${part.connections}`);
  throw new Error(
    `Invalid Postgres connection budget: ${budget.total} connections at the peak, more than max_connections ` +
      `(${budget.limit}). The pooler can hold ${budget.pooled} (pgPoolerInstances ${instances} x (${POOLED_POOLS.length} ` +
      `pooled database/role pairs x pgPoolerPoolSize ${poolSize} + ${POSTGRES_POOLER.authConnections} auth session)) ` +
      `and the direct connections need ${budget.reserveTotal} (${parts.join(", ")}). ` +
      "Lower pgPoolerPoolSize or pgPoolerInstances, or raise POSTGRES_TUNING.maxConnections (and the primary's memory with it).",
  );
}
