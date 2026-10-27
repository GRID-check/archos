/**
 * The VLM call ceiling: the ingest worker's peak concurrent calls against the provider limit.
 */
import type { GridConfig } from "../config";

/**
 * Vision calls the ingest tier can have in flight at its ceiling: replicas, times
 * the jobs one replica runs at once, times the files' own parallelism
 * (`GRID_VLM_BATCH_WORKERS`). Every one of them asks the shared provider key for a
 * slot of the fleet pool (`GRID_VLM_FLEET_CONCURRENCY`).
 */
export function vlmPeakCalls(cfg: Pick<GridConfig, "ingestWorker" | "providerLimits">): number {
  return cfg.ingestWorker.maxReplicas * cfg.ingestWorker.concurrency * cfg.providerLimits.vlmBatchWorkers;
}

/**
 * How far past the fleet pool the ingest tier may be sized. Callers over the pool
 * wait for a slot, which is what the pool is for, so some overshoot is a queue
 * that keeps the pool busy between files; a lot of it is replicas that only hold
 * memory while they wait, and a wait long enough to meet the vision client's
 * timeout (`GRID_VLM_TIMEOUT_SECONDS`) is a retry for nothing.
 */
export const VLM_OVERSUBSCRIPTION = 2;

/**
 * Refuse an ingest tier whose peak vision calls run past the fleet's ceiling by
 * more than {@link VLM_OVERSUBSCRIPTION}, and a fleet pool larger than either
 * limiter ceiling it passes through: the key-wide one, and the vision model's
 * own (every vision call holds a slot in both, and the model's pool is the
 * smaller by default, so a bigger fleet pool could never fill). The numbers are chosen in two
 * places (the tier's replicas, the provider's budget) and neither looks wrong
 * alone, which is how a tier gets raised until its replicas queue on a pool
 * sized for a fraction of them.
 *
 * Skipped when the pool is off (`vlmFleetConcurrency` 0: nothing is held back).
 */
export function assertVlmPeakFitsCeiling(cfg: Pick<GridConfig, "ingestWorker" | "providerLimits">): void {
  const { vlmFleetConcurrency, vlmBatchWorkers, limitCeiling, modelLimitCeiling } = cfg.providerLimits;
  if (vlmFleetConcurrency === 0) return;
  const peak = vlmPeakCalls(cfg);
  const allowed = VLM_OVERSUBSCRIPTION * vlmFleetConcurrency;
  if (peak > allowed) {
    const { maxReplicas, concurrency } = cfg.ingestWorker;
    throw new Error(
      `Invalid ingest sizing: ingestWorkerMaxReplicas (${maxReplicas}) x ingestWorkerConcurrency (${concurrency}) ` +
        `x vlmBatchWorkers (${vlmBatchWorkers}) = ${peak} vision calls at the peak, more than ` +
        `${VLM_OVERSUBSCRIPTION}x vlmFleetConcurrency (${vlmFleetConcurrency}) = ${allowed}. The extra replicas ` +
        "would only queue on the fleet pool and add cost without throughput. Lower ingestWorkerMaxReplicas " +
        `to ${Math.max(1, Math.floor(allowed / (concurrency * vlmBatchWorkers)))} or less, or raise vlmFleetConcurrency ` +
        "(and the provider's own limit with it).",
    );
  }
  if (vlmFleetConcurrency > limitCeiling) {
    throw new Error(
      `Invalid provider budget: vlmFleetConcurrency (${vlmFleetConcurrency}) is above providerLimitCeiling ` +
        `(${limitCeiling}), the key-wide limit every model call passes. The fleet pool could never fill. ` +
        "Raise providerLimitCeiling or lower vlmFleetConcurrency.",
    );
  }
  if (vlmFleetConcurrency > modelLimitCeiling) {
    throw new Error(
      `Invalid provider budget: vlmFleetConcurrency (${vlmFleetConcurrency}) is above providerModelLimitCeiling ` +
        `(${modelLimitCeiling}), the limit on calls in flight to one model, which the vision model's calls also pass. ` +
        "Its own pool would hold the calls back below the fleet pool, so the extra slots and the replicas sized " +
        "to them would only wait. Raise providerModelLimitCeiling (and the provider's own limit with it) or lower " +
        "vlmFleetConcurrency.",
    );
  }
}
