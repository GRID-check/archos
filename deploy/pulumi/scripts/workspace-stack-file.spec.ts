import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
// @ts-expect-error -- a plain .mjs script with no type declarations
import { workspaceStackFile } from "./workspace-stack-file.mjs";

/**
 * The `workspace` stack file is derived from the legacy one at deploy time
 * (ADR-0147), so the two projects plan with the same configuration while both
 * exist. Pinned here against the real committed stack files, not a fixture:
 * a new key added to Pulumi.dev.yaml has to come through, and a `secure:`
 * value, which opens only under the legacy stack's key, never does.
 */

type StackFile = { environment?: string[]; config: Record<string, unknown> };

for (const stack of ["dev", "prod"]) {
  describe(`the workspace stack file for ${stack}`, () => {
    const legacyText = readFileSync(join(__dirname, "..", `Pulumi.${stack}.yaml`), "utf8");
    const legacy = load(legacyText) as StackFile;
    const { text, droppedSecure } = workspaceStackFile(legacyText) as { text: string; droppedSecure: string[] };
    const ws = load(text) as StackFile;

    it("carries every plaintext key under workspace:, with its value", () => {
      for (const [key, value] of Object.entries(legacy.config)) {
        const local = key.replace(/^grid-oib:/, "");
        if (value !== null && typeof value === "object" && "secure" in value) continue;
        if (local === "namespace") continue;
        expect(ws.config[`workspace:${local}`], key).toEqual(value);
      }
    });

    it("has no grid-oib: key and no secure: value", () => {
      expect(Object.keys(ws.config).filter((k) => !k.startsWith("workspace:"))).toEqual([]);
      expect(text).not.toMatch(/\bsecure:/);
    });

    it("names the secure keys it left out, for the ESC step to carry", () => {
      const secure = Object.entries(legacy.config)
        .filter(([, v]) => v !== null && typeof v === "object" && "secure" in v)
        .map(([k]) => k.replace(/^grid-oib:/, ""));
      expect(droppedSecure).toEqual(secure);
    });

    it("deploys into the namespace workspace, whatever the legacy file pins", () => {
      expect(ws.config["workspace:namespace"]).toBe("workspace");
    });

    it("imports the workspace ESC environment instead of the legacy one", () => {
      expect(ws.environment).toEqual((legacy.environment ?? []).map((e) => e.replace(/^grid-oib\//, "workspace/")));
    });
  });
}
