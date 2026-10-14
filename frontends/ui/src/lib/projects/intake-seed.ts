/**
 * What creating a project with „Piloti richtet ein" writes beyond the project:
 * the `project_intakes` row and the profile facts the address already decides
 * (ADR-0111, `docs/design/agentic-project-intake.md`).
 *
 * The address search's hit is evidence, not a guess: a person chose it from the
 * geocoder's list, so `standort_adresse`, `country` and `bundesland` go onto the
 * profile as confirmed facts, the first one carrying the geocoder as its source.
 * A Bundesland chosen by hand (no geocoder configured) is a fact without
 * evidence.
 *
 * The profile and the intake row are one write (`seedProjectProfile`'s
 * `inTransaction`), so a project never has facts without its intake or the
 * other way round. The write skips the access check for the reason
 * `createProject` closes a new project through the repository: the creator's
 * FGA grant may not have propagated yet.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { NewProjectIntakeRow, Project } from '@/lib/db/schema'
import type { GeocodeResult } from '@/lib/geocoding/types'
import { insertProjectIntake } from '@/lib/project-intake/repository'
import type { ClosingIntent } from '@/lib/project-intake/types'
import { emptyProjectProfile, pruneResolvedAssumptions } from '@/lib/project-profile/patch-engine'
import { seedProjectProfile } from '@/lib/project-profile/profile-service'
import { salvageProjectProfile } from '@/lib/project-profile/salvage'
import type { ProjectFact, ProjectProfile } from '@/lib/project-profile/types'
import { inProjectTransaction } from './repository'

export interface IntakeSeedInput {
  description?: string | undefined
  location?: GeocodeResult | undefined
  /** An A2_land token chosen by hand, when no address was searched. */
  bundesland?: string | undefined
  closing?: ClosingIntent | undefined
}

function fact(value: string, now: Date, evidence?: ProjectFact['evidence']): ProjectFact {
  return {
    value,
    confidence: 'confirmed',
    source: 'onboarding',
    updatedAt: now.toISOString(),
    ...(evidence ? { evidence } : {}),
  }
}

/**
 * The facts a location, or a hand-chosen Bundesland, puts on a new profile.
 * Empty when neither was given. Pure.
 */
export function intakeSeedFacts(
  input: Pick<IntakeSeedInput, 'location' | 'bundesland'>,
  now: Date
): Record<string, ProjectFact> {
  const { location } = input
  const bundesland = location?.bundesland ?? input.bundesland ?? null
  const facts: Record<string, ProjectFact> = {}
  if (location) {
    facts.standort_adresse = fact(location.label, now, [
      { kind: 'geocoder', provider: 'photon', label: location.label, resolvedAt: now.toISOString() },
    ])
  }
  if (location || bundesland) facts.country = fact('at', now)
  if (bundesland) facts.bundesland = fact(bundesland, now)
  return facts
}

/** The intake row of a project being created: waiting for its documents. */
export function intakeRowFor(
  session: Pick<AuthorizedSession, 'organizationId' | 'userId'>,
  projectId: string,
  input: IntakeSeedInput
): NewProjectIntakeRow {
  return {
    organizationId: session.organizationId,
    projectId,
    createdBy: session.userId,
    mode: input.closing ? 'closing' : 'active',
    description: input.description?.trim() || null,
    location: input.location ?? null,
    closing: input.closing ?? null,
    status: 'waiting',
  }
}

/** Write the intake row, and the profile facts with it when there are any. Throws on failure; the caller rolls the project back. */
export async function startProjectIntake(
  session: AuthorizedSession,
  project: Project,
  input: IntakeSeedInput,
  now: Date
): Promise<void> {
  const row = intakeRowFor(session, project.id, input)
  const seeded = intakeSeedFacts(input, now)
  const insertRow = async (tx: Parameters<typeof insertProjectIntake>[0]): Promise<void> => {
    await insertProjectIntake(tx, row)
  }
  if (Object.keys(seeded).length === 0) {
    await inProjectTransaction(session.organizationId, insertRow)
    return
  }
  const base: ProjectProfile = salvageProjectProfile(project.profile).profile ?? emptyProjectProfile()
  const profile = pruneResolvedAssumptions({ ...base, facts: { ...base.facts, ...seeded } })
  await seedProjectProfile(project, profile, insertRow)
}
