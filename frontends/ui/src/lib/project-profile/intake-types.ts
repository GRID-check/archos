/**
 * The shape of the intake wizard: stages, questions, options, conditions and answer modes.
 */

// Type-only, and deliberately so: `document-roles` imports the condition
// evaluator (`intake-conditions`) as a VALUE. A type import is erased at
// compile time, so the two reference each other without a runtime cycle.
import type { DocumentRole } from './document-roles'


export type ProjectIntakeQuestionType =
  | 'single_select'
  | 'multi_select'
  | 'boolean'
  | 'number'
  | 'text'
  | 'textarea'
  | 'number_tri'
  | 'yes_no_open'
  | 'upload'
  | 'document_role'
  | 'info_placeholder'

/** The three answer-modes a number_tri question persists. */
export type IntakeAnswerMode = 'value' | 'estimated' | 'open'

/** The three-valued yes_no_open answer. */
export type YesNoOpen = 'yes' | 'no' | 'open'

export type ProjectIntakeScope = 'project' | 'plot' | 'building'

export interface ProjectIntakeOption {
  value: string
  label: string
}

/**
 * A single display condition. Multiple conditions on one question are
 * AND-combined. `param` references another question's id; it is resolved within
 * the same scope instance (a building question's condition on `C1` reads *this*
 * bauwerk's C1), falling back to the project-global answer for project-scope
 * params such as `A5`.
 */
export interface ProjectIntakeCondition {
  param: string
  /**
   * `lte` is numeric and only satisfied when a value exists AND its answer mode is not 'open'.
   * `excludes_any` holds when the answer holds none of the values, so an unanswered param holds it.
   */
  op: 'equals' | 'includes_any' | 'excludes_any' | 'not_empty' | 'lte'
  value?: string | string[] | number
}

export interface ProjectIntakeQuestion {
  id: string
  label: string
  type: ProjectIntakeQuestionType
  /** Short helper under the label. */
  help?: string
  /** One-sentence legal rationale, shown behind a "Warum fragen wir das?" toggle. */
  why?: string
  /** Extra guidance / definition hint. */
  hint?: string
  /** Unit suffix for numeric questions (m, m², dB …). */
  unit?: string
  /**
   * For `document_role`: which slot this question fills. The binding is stored
   * in `document_roles`, not in the answer map — a document is not an answer,
   * and putting a file id in the profile would make the profile the second
   * place a binding lives.
   */
  role?: DocumentRole
  /**
   * Sub-heading this question opens within its module.
   *
   * Modul C interleaves two descriptions of the same building — what stands
   * there today (CB*) and what will stand there after the work (C3–C11) — and
   * the Zielzustand principle is the concept's whole basis for deriving the
   * building class. Running them together as one list of twenty-two fields makes
   * "Bestand heute: oberirdische Geschoße" and "Anzahl oberirdischer Geschoße
   * (Zielzustand)" look like the same question asked twice.
   */
  group?: string
  /**
   * Kernfrage: shown in Schnellstart mode; every non-core question the
   * Schnellstart skips is persisted with mode 'open' so the completion
   * checklist in Modul H can list it.
   */
  core?: boolean
  /**
   * Part of the Bebauungsplan extraction core set (concept Kap. 4-B): the
   * values the phase-2 vision extraction targets and the review screen
   * confirms. Descriptive until that flow lands.
   */
  kernset?: boolean
  placeholder?: string
  options?: ProjectIntakeOption[]
  /** AND-combined display conditions. */
  conditions?: ProjectIntakeCondition[]
  writesTo?: string
  /**
   * Hard-required: the wizard blocks advancing until this is answered. Per the
   * konzept only A1/A2/A5 are required; everything else is deliberately soft so
   * the wizard never blocks (an empty answer degrades to an unknown).
   */
  required?: boolean
  /**
   * Skippable: shown with an "optional" hint. Purely cosmetic — non-required
   * questions are already non-blocking; this just labels the ones worth flagging.
   */
  optional?: boolean
  /**
   * For `info_placeholder`: the id of the system derivation that will appear
   * here in phase 2 (e.g. `building_class`, `uvp`). Purely descriptive.
   */
  derives?: string
  /**
   * The documents (German kinds, as an Austrian office names them) where the
   * value is usually stated: „Einreichplan (Schnitt)", „Baubeschreibung". The
   * intake agent reads them first and a Rückfrage names them. Descriptive:
   * nothing validates a document against it.
   */
  foundIn?: string[]
  /**
   * The derivation this value is an input of. Descriptive here; `lib/project-intake`
   * reads it to know which gaps could change the building class.
   */
  feeds?: 'building_class'
}

/** A per-use zone question set (module D `zone_definitions`). */
export interface ProjectIntakeZoneDefinition {
  questions: ProjectIntakeQuestion[]
}

export interface ProjectIntakeStage {
  id: string
  title: string
  description?: string
  scope: ProjectIntakeScope
  /** `building` modules render once per building. */
  repeatable?: boolean
  questions: ProjectIntakeQuestion[]
  /** Module D: questions asked for every selected use-zone. */
  zoneCommon?: ProjectIntakeQuestion[]
  /** Module D: use-specific follow-up questions, keyed by the D0 option value. */
  zoneDefinitions?: Record<string, ProjectIntakeZoneDefinition>
}

export interface ProjectIntakeDefinition {
  version: number
  stages: ProjectIntakeStage[]
}
