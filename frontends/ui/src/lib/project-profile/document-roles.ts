/**
 * What role a document plays in a project — the declaration the wizard has been
 * missing.
 *
 * The repo already labels documents three ways, and none of them can answer
 * "which file is THE Bebauungsplan for this project":
 *
 *   - `tags` (`lib/documents/tag-vocabulary`) are content labels, LLM-guessed at
 *     ingestion and many-to-many. Three files can carry "Bebauungsplan": the
 *     real one, a scan of the neighbour's, and a PDF of the legal text. A tag
 *     cannot say which one governs, and carries no user commitment.
 *   - `doc_class` ("Dokumentart") is single-valued and human-set, but it is the
 *     norm-hierarchy axis that drives retrieval lanes for the BASE corpus. A
 *     project's Bebauungsplan has no lane to sit in.
 *   - folders are a renameable string. Building extraction on "the folder called
 *     Bebauungsplan" is inference-from-a-name, which is the move ADR-0047 exists
 *     to delete.
 *
 * A role is a fourth, genuinely different axis: a DECLARED, SCOPED binding
 * between a document and a slot in the project model. Scoped is the part the
 * other three cannot express — "Bestandsplan *of building bldg2*" — and without it
 * the whole thing is useless for the mixed Neubau/Bestand projects the intake
 * concept exists to serve.
 *
 * This module is the vocabulary and its rules. Storage is
 * `lib/db/schema/document-roles`; nothing here touches the database.
 */

import { evaluateIntakeConditions } from './intake-definition'
import type { ProjectIntakeCondition, ProjectIntakeScope } from './intake-definition'
import type { ProjectPrimitiveValue } from './types'

/**
 * The closed set of roles, ordered so the UI renders deterministically.
 *
 * Derived from the intake concept: `B2_upl` (the Bebauungsplan upload that
 * starts the extraction flow) plus the Modul I document-onboarding categories.
 * Closed on purpose, for the same reason `ALLOWED_TAGS` is: free-form roles
 * produce semantic duplicates ("Bestandsplan" vs "Bestandspläne" vs "Plan
 * Bestand") that no downstream consumer can match on.
 */
export const DOCUMENT_ROLES = [
  'development_plan',
  'zoning_plan',
  'land_register_extract',
  'site_plan',
  'existing_plans',
  'existing_photos',
  'expert_report_ground',
  'expert_report_noise',
  'expert_report_pollutants',
  'preliminary_design_study',
  'authority_correspondence',
  'preliminary_decision',
  'other_project_basis',
] as const

export type DocumentRole = (typeof DOCUMENT_ROLES)[number]

/**
 * The roles as they were stored before migration 0167. A browser tab that has
 * not reloaded and an older pod can still send one; `canonicalDocumentRole`
 * maps it so the German value is never written again. Remove after one release.
 */
export const LEGACY_DOCUMENT_ROLES: Readonly<Record<string, DocumentRole>> = {
  bebauungsplan: 'development_plan',
  flaechenwidmungsplan: 'zoning_plan',
  grundbuchauszug: 'land_register_extract',
  lageplan: 'site_plan',
  bestandsplan: 'existing_plans',
  foto_bestand: 'existing_photos',
  gutachten_baugrund: 'expert_report_ground',
  gutachten_laerm: 'expert_report_noise',
  gutachten_schadstoffe: 'expert_report_pollutants',
  vorentwurf_studie: 'preliminary_design_study',
  behoerdenkorrespondenz: 'authority_correspondence',
  vorbescheid: 'preliminary_decision',
  sonstige_projektgrundlage: 'other_project_basis',
}

/** The current role for a value that may be a legacy one; anything else passes through for validation. */
export const canonicalDocumentRole = (value: unknown): unknown =>
  typeof value === 'string' ? (LEGACY_DOCUMENT_ROLES[value] ?? value) : value

/**
 * How many documents a role can hold.
 *
 * `one` is a claim about the world, not a storage convenience: a project has one
 * governing Bebauungsplan, and a second one means the first was superseded.
 * `many` is the normal case — a Bestandsplan set is a dozen sheets, and refusing
 * the thirteenth would be arbitrary.
 */
export type RoleCardinality = 'one' | 'many'

export interface DocumentRoleDefinition {
  role: DocumentRole
  /** German label, shown as the slot's name. */
  label: string
  /**
   * Which level of the project model this role binds to. A `bauwerk` role
   * carries the building's instance id; `projekt` and (for now) `grundstueck`
   * roles carry none — see `roleRequiresScopeInstance`.
   *
   * This is the field that makes roles work at all for a project with a Neubau
   * and a Bestand in it: "the Bestandsplan" is not a project fact.
   */
  scope: ProjectIntakeScope
  cardinality: RoleCardinality
  /**
   * When the checklist should push this role, in the same condition language
   * the intake questions already use, evaluated by `evaluateIntakeConditions`.
   *
   * Sharing the evaluator is the point: Modul I's "adaptive checklist" and its
   * "dringend empfohlen" flag become DATA rather than bespoke UI code, and they
   * can never disagree with the question conditions about what a project is.
   */
  recommendedWhen?: ProjectIntakeCondition[]
  /** One line on why this document matters, shown under the slot. */
  why?: string
}

/**
 * The registry. Order is the order the checklist renders in, so the documents
 * that unblock the most downstream work come first.
 */
export const DOCUMENT_ROLE_DEFINITIONS: readonly DocumentRoleDefinition[] = [
  {
    role: 'development_plan',
    label: 'Bebauungsplan',
    scope: 'grundstueck',
    cardinality: 'one',
    recommendedWhen: [{ param: 'B2', op: 'equals', value: 'ja' }],
    why: 'Grundlage für Bauklasse, Bebauungsweise, Dichte und Fluchtlinien.',
  },
  {
    role: 'zoning_plan',
    label: 'Flächenwidmungsplan',
    scope: 'grundstueck',
    cardinality: 'one',
    why: 'Zeigt, ob die geplante Nutzung am Standort grundsätzlich möglich ist.',
  },
  {
    role: 'land_register_extract',
    label: 'Grundbuchauszug',
    scope: 'grundstueck',
    cardinality: 'one',
  },
  {
    role: 'site_plan',
    label: 'Lageplan',
    scope: 'grundstueck',
    cardinality: 'one',
  },
  {
    role: 'existing_plans',
    // Short, because this label is repeated with a building name after it, in
    // the slot heading, the drop zone and the agent's context block. The list
    // of drawing types belongs in the explanation, not in the name.
    label: 'Bestandspläne',
    scope: 'bauwerk',
    cardinality: 'many',
    recommendedWhen: [{ param: 'C2', op: 'equals', value: 'existing' }],
    why: 'Grundrisse, Schnitte und Ansichten. Ohne sie bleibt der Vergleich von Bestand und Zielzustand eine Schätzung.',
  },
  {
    role: 'existing_photos',
    label: 'Fotos / Bestandsaufnahme',
    scope: 'bauwerk',
    cardinality: 'many',
    recommendedWhen: [{ param: 'C2', op: 'equals', value: 'existing' }],
  },
  {
    role: 'expert_report_ground',
    label: 'Baugrundgutachten',
    scope: 'grundstueck',
    cardinality: 'many',
  },
  {
    role: 'expert_report_noise',
    label: 'Lärmgutachten',
    scope: 'grundstueck',
    cardinality: 'many',
    why: 'Liefert die Pegel, die der Wizard bewusst nicht abfragt.',
  },
  {
    role: 'expert_report_pollutants',
    label: 'Schadstoffgutachten',
    scope: 'projekt',
    cardinality: 'many',
    recommendedWhen: [{ param: 'A5', op: 'includes_any', value: ['demolition'] }],
  },
  {
    role: 'preliminary_design_study',
    label: 'Vorentwürfe & Studien',
    scope: 'projekt',
    cardinality: 'many',
  },
  {
    role: 'authority_correspondence',
    label: 'Behördenkorrespondenz',
    scope: 'projekt',
    cardinality: 'many',
  },
  {
    role: 'preliminary_decision',
    label: 'Vorbescheid',
    scope: 'projekt',
    cardinality: 'many',
  },
  {
    role: 'other_project_basis',
    label: 'Sonstige Projektgrundlagen',
    scope: 'projekt',
    cardinality: 'many',
  },
]

/**
 * Whether a binding has been confirmed by a person.
 *
 * Deliberately the same split the project profile already draws between `facts`
 * and `assumptions`: a classifier may SUGGEST that a file is the Bebauungsplan,
 * and only a human turns that into `declared`. It is what makes the concept's
 * `dokument_ungeprüft` state expressible without inventing a fourth answer mode
 * — an extracted value is an assumption whose evidence is a `suggested` binding.
 */
export const ROLE_CONFIDENCES = ['declared', 'suggested'] as const
export type RoleConfidence = (typeof ROLE_CONFIDENCES)[number]

/** Who created the binding. Provenance, kept separate from confidence. */
export const ROLE_SOURCES = ['user', 'wizard', 'classifier'] as const
export type RoleSource = (typeof ROLE_SOURCES)[number]

const DEFINITION_BY_ROLE: ReadonlyMap<DocumentRole, DocumentRoleDefinition> = new Map(
  DOCUMENT_ROLE_DEFINITIONS.map((definition) => [definition.role, definition])
)

export function isDocumentRole(value: string): value is DocumentRole {
  return DEFINITION_BY_ROLE.has(value as DocumentRole)
}

export function isRoleConfidence(value: string): value is RoleConfidence {
  return (ROLE_CONFIDENCES as readonly string[]).includes(value)
}

export function isRoleSource(value: string): value is RoleSource {
  return (ROLE_SOURCES as readonly string[]).includes(value)
}

export function documentRoleDefinition(role: DocumentRole): DocumentRoleDefinition {
  const definition = DEFINITION_BY_ROLE.get(role)
  // Unreachable through the type, but a role read off the wire is a string.
  if (!definition) throw new Error(`Unknown document role: ${role}`)
  return definition
}

export function documentRoleLabel(role: DocumentRole): string {
  return documentRoleDefinition(role).label
}

/**
 * Does this role need a scope instance id, and is the one supplied usable?
 *
 * A `projekt` role takes none; anything narrower requires one. Stated as one
 * function so the API route, the service and the UI cannot each decide
 * differently — the case that produces silent breakage is a `bauwerk` role
 * stored without its building, which then matches every building.
 */
export function roleRequiresScopeInstance(role: DocumentRole): boolean {
  // `bauwerk` only, deliberately. A project has many buildings and the wizard
  // mints an id for each, so a building role without one would match every
  // building. It has exactly ONE plot and mints no id for it (the data model
  // allows more, and v1 starts with one), so demanding an instance for a
  // `grundstueck` role would make the Bebauungsplan unbindable today. When
  // plots become plural they get ids, and this reads `!== 'projekt'`.
  return documentRoleDefinition(role).scope === 'bauwerk'
}

export function isScopeInstanceValid(role: DocumentRole, scopeInstanceId: string | null): boolean {
  const required = roleRequiresScopeInstance(role)
  if (required) return typeof scopeInstanceId === 'string' && scopeInstanceId.length > 0
  return scopeInstanceId === null
}

/**
 * Roles the checklist should push, given the intake answers so far.
 *
 * `instanceId` scopes the evaluation to one building, exactly as it does for a
 * question: without it, a `bauwerk` condition reads the project-global answer
 * and every building gets the same recommendation.
 *
 * A role with no `recommendedWhen` is never *pushed*. It stays offerable — the
 * checklist lists every role — but nothing claims the project needs it.
 */
export function recommendedRoles(
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string
): DocumentRole[] {
  return DOCUMENT_ROLE_DEFINITIONS.filter(
    (definition) =>
      definition.recommendedWhen !== undefined &&
      evaluateIntakeConditions(definition.recommendedWhen, answers, instanceId)
  ).map((definition) => definition.role)
}
