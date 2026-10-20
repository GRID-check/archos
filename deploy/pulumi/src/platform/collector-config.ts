import { dump } from "js-yaml";

/**
 * An OpenTelemetry Collector configuration, built from fragments.
 *
 * Each consumer or source of telemetry (Langfuse, PostHog logs, PostHog
 * metrics, a scrape) is one {@link CollectorFragment}: the components it
 * needs and the pipelines that wire them. {@link composeCollectorConfig}
 * merges the fragments and adds what every collector in this stack carries,
 * so the invariants live in one place instead of in each caller:
 *
 * - **Every OTLP signal has a pipeline.** The OTLP receiver answers a signal
 *   no pipeline carries with an error, which every producer then logs on each
 *   export. A signal nothing consumes goes to the collector's own `nop`
 *   exporter, which accepts and discards.
 * - **Every pipeline starts with `memory_limiter` and ends its processors with
 *   `batch`,** in the order the collector requires: back-pressure first,
 *   batching last.
 * - **Names are unique.** Two fragments declaring one component name is a
 *   wiring mistake, and is refused here rather than silently overwritten.
 *
 * The result is serialised once, to YAML, by {@link renderCollectorConfig}.
 */

export type Signal = "traces" | "logs" | "metrics";
export const SIGNALS: readonly Signal[] = ["traces", "logs", "metrics"];

/** A component's configuration, exactly as the collector reads it. */
export type ComponentConfig = Record<string, unknown> | null;

export interface Pipeline {
  receivers: string[];
  /** The fragment's own processors; `memory_limiter` and `batch` are added around them. */
  processors?: string[];
  exporters: string[];
}

export interface CollectorFragment {
  receivers?: Record<string, ComponentConfig>;
  processors?: Record<string, ComponentConfig>;
  exporters?: Record<string, ComponentConfig>;
  /** Keyed `<signal>` or `<signal>/<name>`, as the collector names pipelines. */
  pipelines?: Record<string, Pipeline>;
}

export interface CollectorConfig {
  receivers: Record<string, ComponentConfig>;
  processors: Record<string, ComponentConfig>;
  exporters: Record<string, ComponentConfig>;
  extensions: Record<string, ComponentConfig>;
  service: {
    extensions: string[];
    pipelines: Record<string, { receivers: string[]; processors: string[]; exporters: string[] }>;
  };
}

export const OTLP_GRPC_PORT = 4317;
export const OTLP_HTTP_PORT = 4318;
export const HEALTH_PORT = 13133;

/** The receiver every producer sends to. */
export const OTLP_RECEIVER = "otlp";

const BASE_PROCESSORS: Record<string, ComponentConfig> = {
  memory_limiter: { check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 25 },
  batch: { timeout: "5s", send_batch_size: 1024 },
};

/**
 * A bounded queue and a bounded retry for an exporter that leaves the cluster.
 * Exporters on one pipeline share a fate for back-pressure, so an unbounded
 * queue behind a slow consumer would grow collector memory until
 * `memory_limiter` refused the pipeline's traffic. Nothing here is in a request
 * path: dropped telemetry is the accepted failure.
 */
export function boundedDelivery(queueSize: number): Record<string, unknown> {
  return {
    sending_queue: { enabled: true, queue_size: queueSize },
    retry_on_failure: { enabled: true, initial_interval: "5s", max_interval: "30s", max_elapsed_time: "300s" },
  };
}

/** Which signal a pipeline carries, from its name (`metrics/posthog` -> `metrics`). */
export function pipelineSignal(name: string): Signal {
  const signal = name.split("/")[0] as Signal;
  if (!SIGNALS.includes(signal)) throw new Error(`collector pipeline "${name}" names no signal`);
  return signal;
}

function mergeUnique<T>(kind: string, into: Record<string, T>, from: Record<string, T> | undefined): void {
  for (const [name, value] of Object.entries(from ?? {})) {
    if (name in into) throw new Error(`collector ${kind} "${name}" is declared twice`);
    into[name] = value;
  }
}

/**
 * Merge `fragments` into one configuration. `otlpReceiver` false builds a
 * collector that takes no OTLP at all (a scrape-only agent), which then needs
 * no pipeline per signal.
 */
export function composeCollectorConfig(
  fragments: CollectorFragment[],
  { otlpReceiver = true }: { otlpReceiver?: boolean } = {},
): CollectorConfig {
  const receivers: Record<string, ComponentConfig> = otlpReceiver
    ? {
        [OTLP_RECEIVER]: {
          protocols: {
            grpc: { endpoint: `0.0.0.0:${OTLP_GRPC_PORT}` },
            http: { endpoint: `0.0.0.0:${OTLP_HTTP_PORT}` },
          },
        },
      }
    : {};
  const processors: Record<string, ComponentConfig> = { ...BASE_PROCESSORS };
  const exporters: Record<string, ComponentConfig> = {};
  const pipelines: Record<string, Pipeline> = {};
  for (const fragment of fragments) {
    mergeUnique("receiver", receivers, fragment.receivers);
    mergeUnique("processor", processors, fragment.processors);
    mergeUnique("exporter", exporters, fragment.exporters);
    mergeUnique("pipeline", pipelines, fragment.pipelines);
  }
  Object.keys(pipelines).forEach(pipelineSignal);

  if (otlpReceiver) {
    for (const signal of SIGNALS) {
      const carried = Object.entries(pipelines).some(
        ([name, p]) => pipelineSignal(name) === signal && p.receivers.includes(OTLP_RECEIVER),
      );
      if (carried) continue;
      exporters.nop ??= null;
      mergeUnique("pipeline", pipelines, { [signal]: { receivers: [OTLP_RECEIVER], exporters: ["nop"] } });
    }
  }

  return {
    receivers,
    processors,
    exporters,
    extensions: { health_check: { endpoint: `0.0.0.0:${HEALTH_PORT}` } },
    service: {
      extensions: ["health_check"],
      pipelines: Object.fromEntries(
        Object.entries(pipelines).map(([name, p]) => [
          name,
          { ...p, processors: ["memory_limiter", ...(p.processors ?? []), "batch"] },
        ]),
      ),
    },
  };
}

/** The collector's config file. YAML for the operator reading the ConfigMap; nothing in it is anchored or folded. */
export function renderCollectorConfig(config: CollectorConfig): string {
  return dump(config, { lineWidth: -1, noRefs: true, sortKeys: false });
}
