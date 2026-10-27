/**
 * The web tier: the Next.js frontend and the landing site.
 */
import * as pulumi from "@pulumi/pulumi";
import type { GridConfig } from "../config";
import { num } from "./readers";
import type { ResourceSpec } from "./resources";

export interface FrontendConfig {
  resources: ResourceSpec;
  minReplicas: number;
  maxReplicas: number;
  /** HPA target average CPU utilisation (%). */
  hpaCpuTargetPercent: number;
}

export interface WebConfig {
  resources: ResourceSpec;
  minReplicas: number;
  maxReplicas: number;
  /** HPA target average CPU utilisation (%). */
  hpaCpuTargetPercent: number;
}

export function loadWebTier(cfg: pulumi.Config): Pick<GridConfig, "frontend" | "web"> {
  // Fail fast: the web PDB allows maxUnavailable 1, so a webMinReplicas of 1
  // means a voluntary disruption (node drain, rolling update) takes the whole
  // landing site down. Two replicas is the floor the PDB contract assumes.
  const webMinReplicas = num(cfg, "webMinReplicas", 2);
  if (webMinReplicas < 2) {
    throw new Error(
      `grid-oib:webMinReplicas must be >= 2 (got ${webMinReplicas}). The web PodDisruptionBudget ` +
        "allows maxUnavailable 1, so a single replica means a full landing-site outage during " +
        "any voluntary disruption.",
    );
  }
  return {
    frontend: {
      /**
       * `requests` is load-bearing twice over, and both uses want the same
       * number: roughly what a pod actually consumes at steady state.
       *
       *   1. **The HPA divides by it.** `averageUtilization` is a percentage of
       *      REQUESTS, not of limits. At the previous `100m`, the 70% target
       *      meant 70 millicores — 7% of the pod's own 1-core limit — which a
       *      Next.js SSR pod clears the moment it serves anything. The HPA
       *      therefore had no proportional range: idle sat at `minReplicas` and
       *      any traffic at all pinned it to `maxReplicas`. At `500m` the target
       *      is 350m, i.e. scale out at ~35% of the limit, leaving burst room.
       *   2. **The scheduler bin-packs on it.** `100m` told the scheduler each
       *      pod was tiny, so all `maxReplicas` could land on one node — and
       *      `topologySpreadConstraints` is `ScheduleAnyway` (soft, by design),
       *      so it would not prevent that. The PDB and the spread policy both
       *      assume replicas are actually spread.
       *
       * Tune from real usage (`kubectl top pods -l app.kubernetes.io/name=frontend`)
       * rather than from this default; the invariant to preserve is
       * `requests ≈ steady-state` and `limits ≈ 2x requests` for burst.
       */
      resources: {
        requestsCpu: cfg.get("frontendRequestsCpu") ?? "500m",
        requestsMemory: cfg.get("frontendRequestsMemory") ?? "512Mi",
        limitsCpu: cfg.get("frontendLimitsCpu") ?? "1",
        limitsMemory: cfg.get("frontendLimitsMemory") ?? "1Gi",
      },
      minReplicas: num(cfg, "frontendMinReplicas", 2),
      maxReplicas: num(cfg, "frontendMaxReplicas", 6),
      hpaCpuTargetPercent: num(cfg, "frontendHpaCpuTargetPercent", 70),
    },
    web: {
      // Static-first site: requests are a floor for the HPA and the scheduler,
      // limits only a burst ceiling. The Astro server barely idles above zero,
      // but the request must stay proportional to the HPA: at 70% target the
      // trigger (70m at 100m requests) must clear ~15% of the 250m limit or
      // assertHpaTargetIsProportional fails the deploy (see frontend tier).
      resources: {
        requestsCpu: cfg.get("webRequestsCpu") ?? "100m",
        requestsMemory: cfg.get("webRequestsMemory") ?? "128Mi",
        limitsCpu: cfg.get("webLimitsCpu") ?? "250m",
        limitsMemory: cfg.get("webLimitsMemory") ?? "256Mi",
      },
      minReplicas: webMinReplicas,
      maxReplicas: num(cfg, "webMaxReplicas", 4),
      hpaCpuTargetPercent: num(cfg, "webHpaCpuTargetPercent", 70),
    },
  };
}
