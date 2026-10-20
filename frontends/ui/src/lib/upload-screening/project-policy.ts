/**
 * The office's sensitive-data list, as one project uses it (ADR-0086, the
 * 2026-10-20 amendment; ticket 26, step „Ablage").
 *
 * An office keeps one list. A project may change its NAME half for itself: add
 * a term only this project needs („Wettbewerb intern"), or set aside one of the
 * office's terms that holds back what this project needs („Vertrag" in a
 * project whose „Verträge" folder is the Bauvertrag and the Werkverträge).
 *
 * Only the name half, on purpose. The name gate is what a person sees before
 * the upload (the tree shows which folders a term holds back), so a change to
 * it can be checked against its effect on the spot. The content gate runs
 * inside the ingest job on text nobody has seen yet; its terms are narrow
 * phrases an admin chose for the whole office, and a project-wide change there
 * would be blind. It stays the office's.
 *
 * A switched-off office list stays off: a project cannot screen alone what the
 * office decided not to screen, and an empty office list with project terms
 * would read as „screened" while the content gate is off.
 *
 * Pure and client-safe: the step previews a draft with it before saving.
 */

import { z } from 'zod'
import { foldForScreening } from './name-screen'
import { normalizeTermList, type UploadScreeningPolicy } from './policy'

/** What one project changes about the office's name terms. */
export interface ProjectScreeningOverride {
  /** Terms this project holds back on top of the office's. */
  addedNameTerms: string[]
  /** Office terms this project does not hold back. A term the office no longer has is ignored. */
  removedNameTerms: string[]
}

export const EMPTY_PROJECT_OVERRIDE: ProjectScreeningOverride = { addedNameTerms: [], removedNameTerms: [] }

/** Most terms a project adds; the office's own list holds 200. */
export const MAX_PROJECT_ADDED_TERMS = 50
/** Most office terms a project sets aside: every term the office may have. */
export const MAX_PROJECT_REMOVED_TERMS = 200
const MAX_TERM_LENGTH = 80

const projectTermList = (max: number) =>
  z
    .array(z.string().max(MAX_TERM_LENGTH * 2))
    .max(max)
    .transform((terms) => normalizeTermList(terms))
    .refine((terms) => terms.every((term) => term.length <= MAX_TERM_LENGTH), {
      message: `A term is at most ${MAX_TERM_LENGTH} characters`,
    })

/** What a project admin may save. Unknown keys are refused, not dropped. */
export const projectScreeningOverrideSchema = z
  .object({
    addedNameTerms: projectTermList(MAX_PROJECT_ADDED_TERMS),
    removedNameTerms: projectTermList(MAX_PROJECT_REMOVED_TERMS),
  })
  .strict()

const termKey = (term: string): string => foldForScreening(term.trim())

/** Whether the project changes nothing. */
export function isEmptyOverride(override: ProjectScreeningOverride): boolean {
  return override.addedNameTerms.length === 0 && override.removedNameTerms.length === 0
}

/**
 * The override as it means something against this office list: a removed term
 * the office does not have is dropped, and an added term the office already
 * has (or one the project also removes) is dropped. So what is shown and saved
 * is exactly what changes.
 */
export function effectiveOverride(
  office: UploadScreeningPolicy,
  override: ProjectScreeningOverride
): ProjectScreeningOverride {
  const officeKeys = new Set(office.nameTerms.map(termKey))
  const removedNameTerms = normalizeTermList(override.removedNameTerms).filter((term) => officeKeys.has(termKey(term)))
  const removedKeys = new Set(removedNameTerms.map(termKey))
  const addedNameTerms = normalizeTermList(override.addedNameTerms).filter((term) => {
    const key = termKey(term)
    return !officeKeys.has(key) && !removedKeys.has(key)
  })
  return { addedNameTerms, removedNameTerms }
}

/**
 * The policy in force for uploads into this project: the office's, with the
 * project's name terms added and the ones it sets aside left out. Exceptions,
 * content terms and detectors are the office's.
 */
export function applyProjectOverride(
  office: UploadScreeningPolicy,
  override: ProjectScreeningOverride | null
): UploadScreeningPolicy {
  if (!office.enabled || !override || isEmptyOverride(override)) return office
  const { addedNameTerms, removedNameTerms } = effectiveOverride(office, override)
  const removed = new Set(removedNameTerms.map(termKey))
  return {
    ...office,
    nameTerms: [...office.nameTerms.filter((term) => !removed.has(termKey(term))), ...addedNameTerms],
  }
}
