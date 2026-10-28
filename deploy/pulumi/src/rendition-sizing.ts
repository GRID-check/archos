/**
 * How the bff-jobs pool is sized against Gotenberg, and which host its slices
 * run in. Split from `config.ts`, which re-exports it.
 */
import type { GridConfig } from './config'

/**
 * Conversions one Gotenberg replica is sized to take at once: one running and
 * one ready behind it. The second is deliberate (`rendition.ts` in the BFF):
 * it keeps the converter busy between files without queueing anything inside
 * it that could run out of its own API timeout.
 */
export const GOTENBERG_SLOTS_PER_REPLICA = 2;

/** `bffJobsMode`: a value the runner does not know would crash-loop the pool, so it fails the plan. */
export function bffJobsMode(raw: string | undefined): GridConfig["bffJobs"]["mode"] {
  const mode = raw?.trim() || "http";
  if (mode === "http" || mode === "inprocess") return mode;
  throw new Error(`grid-oib:bffJobsMode must be "http" or "inprocess", not "${mode}"`);
}

/**
 * The most office conversions the `bff-jobs` pool can have in flight at
 * Gotenberg at once: its replicas at the ceiling times what one pod runs.
 * Background conversions are claimed from `bff_job_queue` (ADR-0079), so this
 * is the fleet-wide bound that replaced a per-process queue in every frontend
 * pod; readers opening a preview are the frontend pods' own, bounded apart.
 */
export function renditionCeiling(cfg: Pick<GridConfig, "bffJobs">): number {
  return cfg.bffJobs.maxReplicas * cfg.bffJobs.renditionConcurrency;
}

/** What the converter can take: its replicas times {@link GOTENBERG_SLOTS_PER_REPLICA}. */
export function gotenbergCapacity(cfg: Pick<GridConfig, "gotenberg">): number {
  return cfg.gotenberg.replicas * GOTENBERG_SLOTS_PER_REPLICA;
}
