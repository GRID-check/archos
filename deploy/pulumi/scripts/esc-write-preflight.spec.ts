import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The ESC write preflight (ADR-0147), run as the workflow runs it: bash and a
 * `pulumi` stub that records every call and refuses the ones it is told to.
 *
 * Pinned: it touches only the probe environment, it cleans up after itself,
 * and a refusal says which permission is missing. `warn` must never fail the
 * run, because until the move needs the grant a missing one is not a reason
 * to stop deploying; `fail` must.
 */

const SCRIPT = join(__dirname, "esc-write-preflight.sh");
const ROOT = mkdtempSync(join(tmpdir(), "esc-write-preflight-"));
const BIN = join(ROOT, "bin");
const CALLS = join(ROOT, "pulumi-calls");

beforeAll(() => {
  mkdirSync(BIN, { recursive: true });
  writeFileSync(
    join(BIN, "pulumi"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "${CALLS}"`,
      'case "$*" in',
      '  "env init "*) [ -z "${STUB_REFUSE_INIT:-}" ] || { echo "403 Forbidden" >&2; exit 1; } ;;',
      '  "env rm --yes "*) [ -z "${STUB_REFUSE_RM:-}" ] || { echo "403 Forbidden" >&2; exit 1; } ;;',
      "esac",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
});

beforeEach(() => {
  if (existsSync(CALLS)) rmSync(CALLS);
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    env: { PATH: `${BIN}:${process.env.PATH}`, ...env },
    encoding: "utf8",
  });
  const calls = existsSync(CALLS) ? readFileSync(CALLS, "utf8").trim().split("\n") : [];
  return { status: r.status, out: r.stdout + r.stderr, calls };
}

describe("esc-write-preflight.sh", () => {
  it("creates and deletes only the probe environment", () => {
    const r = run(["acme"]);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      "env rm --yes acme/workspace/preflight-probe",
      "env init acme/workspace/preflight-probe",
      "env rm --yes acme/workspace/preflight-probe",
    ]);
    expect(r.out).toContain("ESC write preflight OK");
  });

  it("warns without failing the run when the grant is missing", () => {
    const r = run(["acme"], { STUB_REFUSE_INIT: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("::warning::the Pulumi token needs Environment Write on workspace/*");
    expect(r.out).toContain("403 Forbidden");
  });

  it("fails the run in fail mode, naming the permission", () => {
    const r = run(["acme", "fail"], { STUB_REFUSE_INIT: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("::error::the Pulumi token needs Environment Write on workspace/*");
  });

  it("reports a refused delete too, since the clone step needs to replace what it made", () => {
    const r = run(["acme", "fail"], { STUB_REFUSE_RM: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("deleting acme/workspace/preflight-probe was refused");
  });
});
