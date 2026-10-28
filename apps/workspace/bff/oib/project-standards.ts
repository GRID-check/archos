/**
 * Which OIB guidelines apply to a project, from its stored brief: the one
 * derivation behind the overview panel (`getProjectOverviewData`) and the
 * `GET /api/projects/[id]/standards` route an agent reads. Both call
 * {@link getApplicableStandards}; the Python prompt's twin
 * (`src/aiq_agent/common/applicability.py`) is held to the same verdicts by the
 * shared fixtures in `applicable-standards.test.ts`.
 */

import type { ProjectProfileDisplay } from '@/lib/project-profile/types'
import { emptyProjectProfile } from '@/lib/project-profile/patch-engine'
import { salvageProjectProfile } from '@/lib/project-profile/salvage'
import { getApplicableStandards, type ApplicableStandard } from './applicable-standards'

/** A project's verdicts, with the brief they were derived from. */
export function deriveProjectStandards(row: { profile: unknown; profileDisplay: ProjectProfileDisplay | null | undefined }) {
  // Salvaged like `findProjectInOrg`'s: a project whose intake was never saved
  // stored `{}` before migration 0133.
  const profile = salvageProjectProfile(row.profile).profile ?? emptyProjectProfile()
  return {
    profile,
    applicableStandards: getApplicableStandards(profile),
    // Whether the brief has enough captured facts to tailor the verdicts; false
    // means the six generic ones were answered.
    briefComplete: Boolean(row.profileDisplay?.keyFacts?.length),
  }
}

/** The lean row an agent reads: the English title, the verdict and the one fact that would settle a `check`. */
export function toStandardWire(standard: ApplicableStandard) {
  return {
    code: standard.code,
    title: standard.titleEn,
    status: standard.status,
    reason: standard.reason,
    ...(standard.decidingFact ? { decidingFact: standard.decidingFact } : {}),
  }
}
