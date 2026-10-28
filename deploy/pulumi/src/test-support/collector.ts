import { load } from "js-yaml";
import type { CollectorConfig } from "../platform/collector-config";

/** The collector's config file as the collector reads it, for assertions on structure rather than layout. */
export function parseCollectorConfig(yaml: string): CollectorConfig {
  return load(yaml) as CollectorConfig;
}

/** A pipeline as the collector runs it: base processors around the fragment's own. */
export function pipeline(exporters: string[], { receivers = ["otlp"], processors = [] as string[] } = {}) {
  return { receivers, processors: ["memory_limiter", ...processors, "batch"], exporters };
}
