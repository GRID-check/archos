import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const pulumiDir = join(__dirname, "..");
const repoRoot = join(pulumiDir, "..", "..");

/** Every spec in this program, node_modules aside. */
function specFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return specFiles(path);
    return name.endsWith(".spec.ts") ? [path] : [];
  });
}

/**
 * The repo files outside deploy/ a spec reads as source, from its
 * `read("a", "b")` / `python(["a", "b"], …)` helpers and `join(repoRoot, …)`.
 * Directories (a spec that scans all of frontends/ui/src) are left out: the
 * infra job would then run on every change to them.
 */
function filesReadOutsideDeploy(): Map<string, string> {
  // Each alternative captures one argument list with a single negated class, so
  // no input can make the match backtrack (CodeQL js/redos).
  const call = /\bread\(([^)]*)\)|\bpython\(\[([^\]]*)\]|\bjoin\(repoRoot,([^)]*)\)/g;
  const found = new Map<string, string>();
  for (const spec of specFiles(pulumiDir)) {
    for (const match of readFileSync(spec, "utf8").matchAll(call)) {
      const path = [...(match[1] ?? match[2] ?? match[3]).matchAll(/"([^"]+)"/g)].map((m) => m[1]).join("/");
      if (path.startsWith("deploy/") || !path.includes("/")) continue;
      const absolute = join(repoRoot, path);
      if (statSync(absolute, { throwIfNoEntry: false })?.isFile()) found.set(path, relative(pulumiDir, spec));
    }
  }
  return found;
}

function covers(glob: string, path: string): boolean {
  if (glob.endsWith("/**")) return path.startsWith(glob.slice(0, -2));
  return glob === path;
}

describe("the infra CI filter", () => {
  it("runs the manifest specs when a file they read as source changes", () => {
    const filters = load(readFileSync(join(repoRoot, ".github", "filters.yml"), "utf8")) as Record<string, string[]>;
    const read = filesReadOutsideDeploy();
    expect(read.size).toBeGreaterThan(10);
    const uncovered = [...read].filter(([path]) => !filters.infra.some((glob) => covers(glob, path)));
    expect(uncovered.map(([path, spec]) => `${path} (read by ${spec})`)).toEqual([]);
  });
});
