/**
 * Kubernetes resource quantities: the spec type, its parsers, and the checks that a request fits its limit.
 */

export interface ResourceSpec {
  requestsCpu: string;
  requestsMemory: string;
  limitsCpu: string;
  limitsMemory: string;
}

/** Map a ResourceSpec to a k8s ResourceRequirements literal. */
export function toResourceRequirements(r: ResourceSpec) {
  return {
    requests: { cpu: r.requestsCpu, memory: r.requestsMemory },
    limits: { cpu: r.limitsCpu, memory: r.limitsMemory },
  };
}

/** Parse a k8s CPU quantity ("500m", "1", "1500m") into millicores. */
export function cpuMillicores(quantity: string): number {
  const trimmed = quantity.trim();
  return trimmed.endsWith("m")
    ? Number(trimmed.slice(0, -1))
    : Number(trimmed) * 1000;
}

/** Parse a k8s memory quantity ("512Mi", "2Gi", "1000000") into bytes. */
export function memoryBytes(quantity: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(
    quantity.trim(),
  );
  if (!match) return NaN;
  const multipliers: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    k: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
  };
  return Number(match[1]) * (match[2] ? multipliers[match[2]] : 1);
}

/**
 * Guard memory requests against memory limits.
 *
 * `toResourceRequirements` forwards whatever strings the config carries, and
 * Kubernetes only rejects them at admission — i.e. after `pulumi up` has already
 * started mutating the cluster. A typo ("512M1") or an inverted pair
 * (request 2Gi, limit 512Mi) fails the preview here instead.
 */
export function assertMemoryFitsLimit(tier: string, r: ResourceSpec): void {
  const requests = memoryBytes(r.requestsMemory);
  const limits = memoryBytes(r.limitsMemory);

  if (
    !Number.isFinite(requests) ||
    !Number.isFinite(limits) ||
    requests <= 0 ||
    limits <= 0
  ) {
    throw new Error(
      `${tier}: could not parse memory resources ` +
        `(requests=${r.requestsMemory}, limits=${r.limitsMemory}).`,
    );
  }

  if (limits < requests) {
    throw new Error(
      `${tier}: memory limit (${r.limitsMemory}) is below the request (${r.requestsMemory}).`,
    );
  }
}

/**
 * Guard the relationship between CPU requests, CPU limits and the HPA target.
 *
 * An HPA's `averageUtilization` is a percentage of **requests**. That makes a
 * too-small request silently destroy the control loop: the absolute trigger
 * drops far below what a pod uses at idle, so the HPA is pinned at
 * `maxReplicas` under any load at all and the "70%" in the config reads
 * reassuring while meaning nothing. It is invisible in review because each
 * individual number looks defensible — only the ratio is wrong.
 *
 * Same spirit as `assertDrainFitsGrace` in rollout.ts: encode the invariant
 * where it can fail the deploy, not in a comment nobody re-reads.
 */
export function assertHpaTargetIsProportional(
  tier: string,
  r: ResourceSpec,
  hpaCpuTargetPercent: number,
): void {
  const requests = cpuMillicores(r.requestsCpu);
  const limits = cpuMillicores(r.limitsCpu);

  if (!Number.isFinite(requests) || !Number.isFinite(limits) || requests <= 0) {
    throw new Error(
      `${tier}: could not parse CPU resources ` +
        `(requests=${r.requestsCpu}, limits=${r.limitsCpu}).`,
    );
  }

  // A NaN or Infinity target would slip past both comparisons below (every
  // comparison against NaN is false), so the validator would accept it.
  if (!Number.isFinite(hpaCpuTargetPercent) || hpaCpuTargetPercent <= 0) {
    throw new Error(
      `${tier}: HPA CPU target must be a finite positive number ` +
        `(got ${hpaCpuTargetPercent}).`,
    );
  }

  const trigger = (requests * hpaCpuTargetPercent) / 100;

  // Below ~15% of the limit the HPA stops being proportional control and
  // becomes an on/off switch to maxReplicas.
  const triggerFractionOfLimit = trigger / limits;
  if (triggerFractionOfLimit < 0.15) {
    throw new Error(
      `${tier}: HPA target of ${hpaCpuTargetPercent}% of ${r.requestsCpu} requests ` +
        `= ${trigger}m, only ${(triggerFractionOfLimit * 100).toFixed(1)}% of the ` +
        `${r.limitsCpu} limit. The HPA will pin to maxReplicas under any load. ` +
        `Raise the CPU request toward real steady-state usage.`,
    );
  }

  if (limits < requests) {
    throw new Error(
      `${tier}: CPU limit (${r.limitsCpu}) is below the request (${r.requestsCpu}).`,
    );
  }
}
