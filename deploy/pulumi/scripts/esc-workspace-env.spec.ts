import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The workspace ESC environment (ADR-0147), made by esc-workspace-env.sh and
 * run here against a `pulumi` stub that keeps one fake environment on disk.
 *
 * Pinned: the legacy environment is only ever read; the key rename saves the
 * definition back only when it holds ciphertext; each step runs once, so a
 * second run writes nothing; and the legacy stack file's secure values reach
 * the clone through the legacy stack's own decryption.
 */

const SCRIPT = join(__dirname, "esc-workspace-env.sh");
const ROOT = mkdtempSync(join(tmpdir(), "esc-workspace-env-"));
const BIN = join(ROOT, "bin");
const STATE = join(ROOT, "state");
const CALLS = join(ROOT, "calls");
const LEGACY_FILE = join(ROOT, "Pulumi.dev.yaml");

const DEFINITION = [
  "imports:",
  "  - shared/base",
  "values:",
  "  pulumiConfig:",
  "    grid-oib:kubeconfig:",
  "      fn::secret:",
  "        ciphertext: ZXNjeAAAAAEAAAEA",
  "    grid-oib:baseDomain: dev.example.test",
].join("\n");

beforeAll(() => {
  mkdirSync(BIN, { recursive: true });
  writeFileSync(
    LEGACY_FILE,
    ["environment:", "  - grid-oib/dev", "config:", "  grid-oib:baseDomain: dev.example.test", "  grid-oib:cloudflareApiToken:", "    secure: AAABAxyz", ""].join("\n"),
  );
  // The stub: `env get <dst> --definition` reads $STATE/def, `env clone`
  // writes it, `env edit --file -` replaces it, `env set` appends a marker,
  // `env get <dst> <path>` answers from the markers.
  writeFileSync(
    join(BIN, "pulumi"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${CALLS}"
case "$1 $2" in
  "env get")
    if [ "\${4:-}" = "--definition" ]; then
      [ -f "${STATE}/def" ] || { echo "not found" >&2; exit 1; }
      if [ -n "\${STUB_REDACTED:-}" ]; then sed 's/ciphertext: .*/[secret]/' "${STATE}/def"; else cat "${STATE}/def"; fi
      exit 0
    fi
    grep -qxF "$4" "${STATE}/set" 2>/dev/null && echo "[secret]"
    exit 0 ;;
  "env clone") printf '%s\\n' "$DEF" > "${STATE}/def" ;;
  "env edit") cat > "${STATE}/def" ;;
  "env set") echo "$4" >> "${STATE}/set" ;;
  "config get") [ -z "\${STUB_NO_DECRYPT:-}" ] || exit 1; echo "plain-$3" ;;
esac
`,
    { mode: 0o755 },
  );
});

beforeEach(() => {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE);
  if (existsSync(CALLS)) rmSync(CALLS);
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function run(env: Record<string, string> = {}, mode = "fail") {
  const r = spawnSync("bash", [SCRIPT, "acme", "dev", LEGACY_FILE, mode], {
    env: { PATH: `${BIN}:${process.env.PATH}`, DEF: DEFINITION, ...env },
    encoding: "utf8",
  });
  const calls = existsSync(CALLS) ? readFileSync(CALLS, "utf8").trim().split("\n") : [];
  const def = existsSync(join(STATE, "def")) ? readFileSync(join(STATE, "def"), "utf8") : "";
  return { status: r.status, out: r.stdout + r.stderr, calls, def };
}

const WRITES = /^env (clone|edit|set|init|rm) /;

describe("esc-workspace-env.sh", () => {
  it("clones, renames the keys and keeps the ciphertext as it was", () => {
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.def).toContain("    workspace:kubeconfig:");
    expect(r.def).toContain("        ciphertext: ZXNjeAAAAAEAAAEA");
    expect(r.def).not.toContain("grid-oib:");
    expect(r.def).toContain("  - shared/base");
  });

  it("writes only the workspace environment", () => {
    const writes = run().calls.filter((c) => WRITES.test(c));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      // clone names the legacy environment as its SOURCE, the only place it appears.
      const target = w.startsWith("env clone ") ? w.split(" ")[3] : w.split(" ")[2];
      expect(target, w).toMatch(/^(acme\/)?workspace\/dev$/);
    }
  });

  it("carries the legacy stack file's secure values through the legacy stack", () => {
    const r = run();
    expect(r.calls).toContain("config get grid-oib:cloudflareApiToken --stack acme/grid-oib/dev --cwd " + ROOT);
    expect(r.calls).toContain("env set acme/workspace/dev pulumiConfig.workspace:cloudflareApiToken plain-grid-oib:cloudflareApiToken --secret --string");
    expect(r.out).toContain("::add-mask::plain-grid-oib:cloudflareApiToken");
  });

  it("writes nothing on a second run", () => {
    run();
    if (existsSync(CALLS)) rmSync(CALLS);
    const again = run();
    expect(again.status, again.out).toBe(0);
    expect(again.calls.filter((c) => WRITES.test(c))).toEqual([]);
  });

  it("refuses to save a redacted definition back", () => {
    const r = run({ STUB_REDACTED: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("came back redacted");
    expect(r.calls.some((c) => c.startsWith("env edit "))).toBe(false);
  });

  it("warns instead of failing in warn mode", () => {
    const r = run({ STUB_NO_DECRYPT: "1" }, "warn");
    expect(r.status).toBe(0);
    expect(r.out).toContain("::warning::ESC environment acme/workspace/dev (ADR-0147): the legacy stack could not decrypt");
  });
});
