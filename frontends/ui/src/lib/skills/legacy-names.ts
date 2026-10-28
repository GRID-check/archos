/**
 * Builtin skills renamed to English (migration 0169), old name to current name.
 *
 * A skill's name is the token people type after a slash, what a stored
 * schedule's prompt says (`/einreichcheck`) and what an older message lists as
 * activated, so the old names keep resolving. `canonicalSkillName` is the one
 * place that maps them; nothing writes an old name again.
 *
 * Mirrored in `packages/agent/src/aiq_agent/skills/builtin.py::LEGACY_SKILL_NAMES`;
 * `legacy-names.spec.ts` reads the Python file and fails when the two differ.
 * Pure data, so a client component can import it. Remove after one release.
 */
export const LEGACY_SKILL_NAMES: Readonly<Record<string, string>> = {
  einreichcheck: 'submission-check',
  brandschutz: 'fire-safety',
  bestand: 'existing-building',
  nutzungssicherheit: 'safety-in-use',
  gebaeudeklasse: 'building-class',
  waermeschutz: 'thermal-protection',
  bebauung: 'plot-development',
  'pruefbericht-writer': 'inspection-report-writer',
}

/** The current name for `name`, following one renamed builtin; any other name as given. */
export function canonicalSkillName(name: string): string {
  return LEGACY_SKILL_NAMES[name] ?? name
}

/** The names this skill was called before the rename, so a typed fragment can still find it. */
export function legacyNamesOf(name: string): string[] {
  return Object.entries(LEGACY_SKILL_NAMES)
    .filter(([, current]) => current === name)
    .map(([legacy]) => legacy)
}
