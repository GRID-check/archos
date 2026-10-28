/**
 * The chat tier (ADR-0080): the backend, the api tier, the agent worker and the conversation bus between them.
 */
import * as pulumi from "@pulumi/pulumi";
import { bool, num } from "./readers";
import type { ResourceSpec } from "./resources";

/**
 * Whether the chat tier autoscales (ADR-0080).
 *
 * Only with affinity off. With it on, the BFF routes by
 * `hash(conversationId) % BACKEND_REPLICAS`, so the replica count is part of the
 * routing: changing it remaps live conversations, and a replica the hash names
 * that does not exist yet is a dead socket. The count is then whatever
 * `backendReplicas` says, and the stack's own `replicas` field owns it.
 */
export function backendAutoscaled(c: { backend: BackendConfig }): boolean {
  return !c.backend.chatAffinity && c.backend.maxReplicas > c.backend.replicas;
}

export interface BackendConfig {
  resources: ResourceSpec;
  /**
   * Research jobs one organization runs at once (0 disables). It is the
   * workers' per-organization claim cap: a job over it waits.
   */
  maxActiveJobsPerOrg: number;
  /**
   * Research jobs one organization may have WAITING (0 disables). Abuse protection and the only 429 left: capacity makes a job
   * wait, never fail.
   */
  maxQueuedJobsPerOrg: number;
  /** Max concurrent document-ingestion workers in the backend process. */
  ingestMaxWorkers: number;
  /** Backend web config file (baked into the image under /app/configs). */
  configFile: string;
  /**
   * Chat replica count. The chat/retrieval path is replica-safe via shared
   * Qdrant + Postgres + cache; see the base-corpus-upload caveat in
   * docs/deployment/kubernetes.md §6.4.
   */
  replicas: number;
  /**
   * Replica ceiling once the chat tier autoscales (ADR-0080): `replicas` is
   * the floor, KEDA moves the count between the two on the fleet's running
   * turns. Autoscaling needs `chatAffinity` off; with it on the count is the
   * hash's modulus and stays `replicas`, whatever this says.
   */
  maxReplicas: number;
  /** Running chat turns, fleet-wide, per replica that KEDA aims for (its metrics-api AverageValue target). */
  turnsPerReplica: number;
  /** CPU utilisation (% of requests) at which the KEDA cpu trigger adds replicas. */
  cpuTargetPercent: number;
  /**
   * `CHAT_DRAIN_SECONDS`: how long a terminating replica waits for its
   * turns before cancelling them. The pod's grace period is this plus the
   * endpoint drain and slack (`backendRollout`), so it must cover the longest
   * chat turn, `CHAT_TURN_DEADLINE_SECONDS` (2700).
   */
  drainSeconds: number;
  /**
   * `CHAT_AFFINITY` (ADR-0080): the BFF pins a conversation to one
   * replica by hash (on, ADR-0028) or hands the socket to the aiq-agent
   * Service and lets the conversation bus decide per turn (off). Prod stays
   * on until the cross-replica path is validated on dev.
   */
  chatAffinity: boolean;
}

export interface ApiConfig {
  resources: ResourceSpec;
  minReplicas: number;
  maxReplicas: number;
  /** HPA target average CPU utilisation (%). */
  hpaCpuTargetPercent: number;
}

export interface AgentWorkerConfig {
  resources: ResourceSpec;
  minReplicas: number;
  maxReplicas: number;
  /** Concurrent research jobs per worker process (RESEARCH_WORKERS); also KEDA's jobs-per-replica target. */
  concurrency: number;
  /**
   * Seconds a terminating worker may spend finishing the research jobs it has
   * already claimed (`RESEARCH_WORKER_DRAIN_SECONDS`). The pod's
   * `terminationGracePeriodSeconds` is this plus 30 s, so the worker has time
   * to give back what it did not finish before the kubelet SIGKILLs it.
   *
   * This is the single most consequential rollout knob in the stack. On
   * SIGTERM the worker stops claiming and awaits its in-flight jobs
   * (`agent_host/jobs/worker.py`); Kubernetes' 30s default kills that drain
   * part-way. A job still running when the budget ends is given back to the
   * queue without costing an attempt and another worker starts it over, so the
   * budget now decides how much work is repeated, not whether any is lost. Set
   * it at or above the p99 job duration to repeat none.
   *
   * The cost is deploy latency: workers roll one at a time and a draining one
   * can hold its slot for this long, so `pulumi up` may take
   * (drain x replicas) in the worst case. Lower it only if you would rather
   * repeat in-flight research than wait.
   */
  drainSeconds: number;
}

export function loadChatTier(
  cfg: pulumi.Config,
): { backend: BackendConfig; api: ApiConfig; conversationBus: boolean; agentWorker: AgentWorkerConfig } {
  const conversationBus = bool(cfg, "conversationBus", true);
  // ── Chat tier scale-out (ADR-0080) ────────────────────────────────────────
  const backendReplicas = Math.max(1, num(cfg, "backendReplicas", 2));
  const backendMaxReplicas = Math.max(1, num(cfg, "backendMaxReplicas", 3));
  const chatAffinity = bool(cfg, "chatAffinity", true);
  if (backendMaxReplicas < backendReplicas) {
    throw new Error(
      `grid-oib:backendMaxReplicas (${backendMaxReplicas}) must be >= backendReplicas ` +
        `(${backendReplicas}), the floor the chat tier scales between.`,
    );
  }
  // The api tier's floor and ceiling, the bounds its HPA moves between.
  const apiMinReplicas = Math.max(1, num(cfg, "apiMinReplicas", 2));
  const apiMaxReplicas = Math.max(1, num(cfg, "apiMaxReplicas", 4));
  if (apiMaxReplicas < apiMinReplicas) {
    throw new Error(
      `grid-oib:apiMaxReplicas (${apiMaxReplicas}) must be >= apiMinReplicas ` +
        `(${apiMinReplicas}), the floor the api tier's HPA scales between.`,
    );
  }
  // Affinity off hands every socket to the Service and leans on the bus to keep
  // one turn running per conversation. Without the bus nothing does: two
  // replicas would each run the question they were handed.
  if (!chatAffinity && !conversationBus) {
    throw new Error(
      "grid-oib:chatAffinity=false needs grid-oib:conversationBus=true: without the Dragonfly " +
        "conversation bus no replica can relay a turn it does not run, or stop a stale one (ADR-0080).",
    );
  }
  return {
    backend: {
      resources: {
        requestsCpu: cfg.get("backendRequestsCpu") ?? "1",
        requestsMemory: cfg.get("backendRequestsMemory") ?? "2Gi",
        limitsCpu: cfg.get("backendLimitsCpu") ?? "4",
        limitsMemory: cfg.get("backendLimitsMemory") ?? "8Gi",
      },
      maxActiveJobsPerOrg: num(cfg, "backendMaxActiveJobsPerOrg", 3),
      maxQueuedJobsPerOrg: num(cfg, "backendMaxQueuedJobsPerOrg", 50),
      ingestMaxWorkers: num(cfg, "backendIngestMaxWorkers", 2),
      configFile: cfg.get("backendConfigFile") ?? "/app/configs/config_oib_openrouter.yml",
      // Multi-replica chat/web tier. Safe because the frontend WS proxy pins each
      // conversation to its owning replica by hash (conversation affinity,
      // ADR-0028), so the in-process WS/HITL/task state is always reachable. The
      // headless service (backend.ts) provides the per-pod DNS this needs.
      replicas: backendReplicas,
      maxReplicas: backendMaxReplicas,
      turnsPerReplica: Math.max(1, num(cfg, "backendTurnsPerReplica", 8)),
      cpuTargetPercent: num(cfg, "backendCpuTargetPercent", 70),
      // The longest chat turn (+ its 30 s cancel grace) once the tier scales: scale-in
      // picks a pod whatever it is running. With affinity on the count is static
      // and a singleton serves nobody while it drains, so the short drain that
      // fits the 90 s grace period the tier has always had stays the default.
      drainSeconds: Math.max(10, num(cfg, "backendDrainSeconds", chatAffinity ? 20 : 2730)),
      chatAffinity,
    },
    api: {
      // Request-bound LLM utilities, knowledge routes and SSE streams: CPU is
      // modest per pod, memory carries the workflow the process builds at boot
      // (the same one the chat tier builds). `requests` is what the HPA divides
      // by, so it stays near steady state (see `frontend`).
      resources: {
        requestsCpu: cfg.get("apiRequestsCpu") ?? "500m",
        requestsMemory: cfg.get("apiRequestsMemory") ?? "1536Mi",
        limitsCpu: cfg.get("apiLimitsCpu") ?? "2",
        limitsMemory: cfg.get("apiLimitsMemory") ?? "6Gi",
      },
      minReplicas: apiMinReplicas,
      maxReplicas: apiMaxReplicas,
      hpaCpuTargetPercent: num(cfg, "apiHpaCpuTargetPercent", 70),
    },
    conversationBus,
    agentWorker: {
      resources: {
        requestsCpu: cfg.get("agentWorkerRequestsCpu") ?? "1",
        requestsMemory: cfg.get("agentWorkerRequestsMemory") ?? "2Gi",
        limitsCpu: cfg.get("agentWorkerLimitsCpu") ?? "4",
        limitsMemory: cfg.get("agentWorkerLimitsMemory") ?? "8Gi",
      },
      // KEDA scales the tier on the research queue's depth (ADR-0079), not on
      // CPU, which an LLM-bound job barely moves. A floor of zero lets it idle
      // while nothing waits.
      minReplicas: Math.max(0, num(cfg, "agentWorkerMinReplicas", 1)),
      maxReplicas: Math.max(1, num(cfg, "agentWorkerMaxReplicas", 8)),
      concurrency: Math.max(1, num(cfg, "agentWorkerConcurrency", 1)),
      // 10 minutes: long enough for a typical deep-research run to land, short
      // enough that a rolling deploy of the tier stays inside the CD timeout.
      // Clamped to a sane floor — a value below the default 30s would be a
      // silent downgrade from Kubernetes' own behaviour.
      drainSeconds: Math.max(30, num(cfg, "agentWorkerDrainSeconds", 600)),
    },
  };
}
