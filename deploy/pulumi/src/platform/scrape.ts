/**
 * How a workload opts into the node agents' scrape (ADR-0119): three pod
 * annotations, by the convention every Prometheus-shaped chart already
 * writes. The agent on the pod's node (`otel-agent.ts`) scrapes
 * `http://<pod ip>:<port><path>` every 30 s and sends the series to PostHog
 * through the gateway, labelled with the pod's namespace, name and container.
 *
 * A pod withheld from the namespace's wholesale allow (rule 2 in
 * `network-policies.ts`) needs a rule admitting `otel-agent` to its metrics
 * port as well, or the scrape times out and nothing says so.
 */

export const SCRAPE_ANNOTATION = {
  scrape: "prometheus.io/scrape",
  port: "prometheus.io/port",
  path: "prometheus.io/path",
} as const;

/** The annotations that ask the node agent to scrape a pod's `port` at `path`. */
export function scrapeAnnotations(port: number, path = "/metrics"): Record<string, string> {
  return { [SCRAPE_ANNOTATION.scrape]: "true", [SCRAPE_ANNOTATION.port]: String(port), [SCRAPE_ANNOTATION.path]: path };
}
