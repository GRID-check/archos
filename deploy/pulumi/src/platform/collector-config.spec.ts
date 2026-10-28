import { describe, expect, it } from "vitest";
import { composeCollectorConfig, renderCollectorConfig } from "./collector-config";
import { parseCollectorConfig, pipeline } from "../test-support/collector";

/**
 * The invariants every collector in the stack carries, held once here instead
 * of per consumer. Each one, broken, is a failure that only shows in the
 * running cluster: a producer logging an export error on every batch, a
 * collector refusing to start, a fragment silently overwriting another's
 * exporter.
 */
describe("composeCollectorConfig", () => {
  const traces = { exporters: { "otlp_http/a": { traces_endpoint: "http://a" } }, pipelines: { traces: { receivers: ["otlp"], exporters: ["otlp_http/a"] } } };

  it("gives every OTLP signal nothing consumes a pipeline into nop", () => {
    const config = composeCollectorConfig([traces]);
    expect(config.exporters).toHaveProperty("nop");
    expect(config.service.pipelines).toEqual({
      traces: pipeline(["otlp_http/a"]),
      logs: pipeline(["nop"]),
      metrics: pipeline(["nop"]),
    });
  });

  it("counts a named pipeline as carrying its signal, and a scrape pipeline as not", () => {
    const config = composeCollectorConfig([
      { exporters: { x: null }, pipelines: { "logs/x": { receivers: ["otlp"], exporters: ["x"] } } },
      { receivers: { "prometheus/y": {} }, pipelines: { "metrics/y": { receivers: ["prometheus/y"], exporters: ["x"] } } },
    ]);
    expect(config.service.pipelines).not.toHaveProperty("logs");
    expect(config.service.pipelines.metrics).toEqual(pipeline(["nop"]));
  });

  it("puts memory_limiter first and batch last around a fragment's own processors", () => {
    const config = composeCollectorConfig([
      { processors: { "filter/x": {} }, exporters: { x: null }, pipelines: { "logs/x": { receivers: ["otlp"], processors: ["filter/x"], exporters: ["x"] } } },
    ]);
    expect(config.service.pipelines["logs/x"].processors).toEqual(["memory_limiter", "filter/x", "batch"]);
  });

  it("refuses a component two fragments both declare", () => {
    expect(() => composeCollectorConfig([traces, { exporters: { "otlp_http/a": {} } }])).toThrow(/exporter "otlp_http\/a" is declared twice/);
  });

  it("refuses a pipeline that names no signal", () => {
    expect(() => composeCollectorConfig([{ pipelines: { spans: { receivers: ["otlp"], exporters: ["nop"] } } }])).toThrow(/names no signal/);
  });

  it("adds no OTLP receiver, and so no nop pipelines, to a collector that takes none", () => {
    const config = composeCollectorConfig(
      [{ receivers: { kubelet_stats: {} }, exporters: { x: null }, pipelines: { metrics: { receivers: ["kubelet_stats"], exporters: ["x"] } } }],
      { otlpReceiver: false },
    );
    expect(config.receivers).not.toHaveProperty("otlp");
    expect(Object.keys(config.service.pipelines)).toEqual(["metrics"]);
  });

  it("renders YAML the collector reads back unchanged, env references and all", () => {
    const config = composeCollectorConfig([
      { exporters: { "otlp_http/a": { headers: { Authorization: "${env:TOKEN}", v: "4" } } }, pipelines: { traces: { receivers: ["otlp"], exporters: ["otlp_http/a"] } } },
    ]);
    const yaml = renderCollectorConfig(config);
    expect(parseCollectorConfig(yaml)).toEqual(config);
    // A version header must stay a string: an unquoted 4 is an int to the collector.
    expect(yaml).toContain("v: '4'");
  });
});
