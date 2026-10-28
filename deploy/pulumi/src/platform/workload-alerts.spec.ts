import { describe, it, expect } from "vitest";
import { load } from "js-yaml";
import { UNAVAILABLE_FOR_MINUTES, workloadAlertRules } from "./workload-alerts";

type Rule = { alert: string; expr: string; for: string; labels: { severity: string }; annotations: Record<string, string> };

const rules = (namespace: string) =>
  (load(workloadAlertRules(namespace)) as { groups: Array<{ rules: Rule[] }> }).groups[0].rules;

describe("the workload alert rules", () => {
  it("fires on a Deployment that should run and has no available replica for 15 minutes", () => {
    const [rule] = rules("grid");
    expect(rule.alert).toBe("DeploymentUnavailable");
    expect(rule.for).toBe("15m");
    expect(UNAVAILABLE_FOR_MINUTES).toBe(15);
    expect(rule.labels.severity).toBe("critical");
    // A Deployment scaled to zero on purpose is not down; one wanting replicas and having none is.
    expect(rule.expr).toBe(
      'kube_deployment_spec_replicas{namespace="grid"} > 0 and kube_deployment_status_replicas_available{namespace="grid"} == 0',
    );
  });

  it("watches the namespace it is rendered for, and quotes it", () => {
    expect(rules("workspace")[0].expr).toContain('namespace="workspace"');
    expect(rules("workspace")[0].annotations.summary).toContain("{{ $labels.deployment }}");
  });
});
