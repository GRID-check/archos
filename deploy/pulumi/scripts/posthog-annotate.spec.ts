import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The deploy marker, run as the workflow runs it: bash and a `curl` stub that
 * records what it was asked to send.
 *
 * Two promises are pinned here. A repository without a PostHog key deploys as
 * before, so the script must exit 0 and send nothing. A repository with one gets
 * exactly one project annotation per deploy, named "deploy <env> <sha>", sent to
 * the app host (not the ingestion host) with the key in a Bearer header, never
 * in the URL or the body.
 */

const SCRIPT = join(__dirname, "posthog-annotate.sh");
const ROOT = mkdtempSync(join(tmpdir(), "posthog-annotate-"));
const BIN = join(ROOT, "bin");
const CALLS = join(ROOT, "curl-calls");
const SHA = "0123456789abcdef0123456789abcdef01234567";

beforeAll(() => {
  mkdirSync(BIN, { recursive: true });
  const bin = join(BIN, "curl");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      '[ -z "${STUB_CURL_FAIL:-}" ] || { echo "HTTP 401" >&2; exit 22; }',
      `printf '%s\\n' "$*" >> "${CALLS}"`,
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  rmSync(CALLS, { force: true });
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${BIN}:${process.env.PATH ?? ""}`,
      POSTHOG_API_KEY: "phx_secret",
      POSTHOG_PROJECT_ID: "269895",
      ...env,
    },
  });
  const calls = existsSync(CALLS) ? readFileSync(CALLS, "utf8").trim().split("\n") : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

describe("posthog-annotate.sh", () => {
  it("sends nothing and succeeds without a key", () => {
    const r = run(["dev", `sha-${SHA}`], { POSTHOG_API_KEY: "" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stdout).toContain("skipping");
  });

  it("sends nothing and succeeds without a project id", () => {
    const r = run(["dev", `sha-${SHA}`], { POSTHOG_PROJECT_ID: "" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it("creates one project annotation named after the env and the sha", () => {
    const r = run(["dev", `sha-${SHA}`]);
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0];
    expect(call).toContain("--request POST");
    expect(call).toContain("https://eu.posthog.com/api/projects/269895/annotations/");
    expect(call).toContain(`"content":"deploy dev ${SHA}"`);
    expect(call).toContain('"scope":"project"');
    expect(call).toMatch(/"date_marker":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"/);
  });

  it("sends the key as a Bearer header only", () => {
    const call = run(["prod", SHA]).calls[0];
    expect(call).toContain("Authorization: Bearer phx_secret");
    expect(call.replace("Authorization: Bearer phx_secret", "")).not.toContain("phx_secret");
  });

  it("takes the host from POSTHOG_CLI_HOST, without a trailing slash", () => {
    const call = run(["dev", SHA], { POSTHOG_CLI_HOST: "https://posthog.example.test/" }).calls[0];
    expect(call).toContain("https://posthog.example.test/api/projects/269895/annotations/");
  });

  it("accepts a release tag as the ref", () => {
    const call = run(["prod", "v1.2.0"]).calls[0];
    expect(call).toContain('"content":"deploy prod v1.2.0"');
  });

  it("fails when PostHog refuses, so the step's continue-on-error is what keeps the deploy green", () => {
    const r = run(["dev", SHA], { STUB_CURL_FAIL: "1" });
    expect(r.status).not.toBe(0);
  });

  it.each([
    ["an env that needs JSON escaping", ['de"v', SHA]],
    ["a ref that needs JSON escaping", ["dev", 'x","scope":"organization']],
    ["an empty ref", ["dev", "sha-"]],
  ])("refuses %s", (_name, args) => {
    const r = run(args);
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });

  it("refuses a project id that is not a number", () => {
    const r = run(["dev", SHA], { POSTHOG_PROJECT_ID: "1/../2" });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });
});
