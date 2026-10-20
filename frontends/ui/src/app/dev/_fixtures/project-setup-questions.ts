/**
 * Step 4, Rückfragen, drawn from fixtures (`/dev/project-setup?step=questions&state=<name>`)
 * and in its specs. The location register is computed by the real register
 * from a profile, so a fixture cannot drift from the register's data: the
 * Aufstockung in Wien the other fixtures describe, a project whose address was
 * typed without a geocoder (no Bundesland yet), a reading still running, a
 * past project, and a round with everything settled.
 */

import { computeNeeds } from '@/lib/project-intake/needs'
import { locationRegisterFor, type LocationRegisterInput } from '@/lib/project-intake/location-register'
import type { IntakeMode, IntakeView, LocationRegisterView } from '@/lib/project-intake/types'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import { emptyProjectProfile } from '@/lib/project-profile/patch-engine'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import { FIXTURE_LOCATION, INTAKE_CLOSING, INTAKE_READING, INTAKE_READY, OPEN_PHASE } from './project-intake'

const AT = '2026-10-20T08:00:00.000Z'

function profileOf(
  facts: Record<string, ProjectPrimitiveValue>,
  suggestions: Record<string, ProjectPrimitiveValue> = {},
  unknowns: string[] = []
): ProjectProfile {
  const profile = emptyProjectProfile()
  for (const [key, value] of Object.entries(facts)) {
    profile.facts[key] = { value, confidence: 'confirmed', source: 'onboarding', updatedAt: AT }
  }
  for (const [key, value] of Object.entries(suggestions)) {
    profile.assumptions[key] = { value, status: 'unconfirmed', reason: 'gelesen', source: 'agent_suggested', updatedAt: AT }
  }
  profile.unknowns.push(...unknowns)
  return profile
}

function registerOf(
  profile: ProjectProfile,
  location: LocationRegisterInput['location'],
  mode: IntakeMode = 'active'
): LocationRegisterView {
  const needs = computeNeeds(profile, projectIntakeDefinitionV1, { mode, dismissed: [] })
  return locationRegisterFor({ profile, location, mode, needs })
}

/** The Aufstockung in Wien: a Bestand with Wohnungen, Zubau and Umbau; the reading found the Widmung. */
const VIENNA_STOREY_ADDITION = {
  country: 'at',
  bundesland: 'wien',
  vorhabensart: ['zubau', 'umbau'],
  'bauwerkstyp@bw1': 'gebaeude',
  'errichtungsstatus@bw1': 'bestand',
  'nutzungen@bw1': ['wohnen'],
}

const REGISTER_READY = registerOf(
  profileOf(VIENNA_STOREY_ADDITION, { flaechenwidmung: 'wohngebiet', bebauungsplan: 'ja' }),
  FIXTURE_LOCATION
)

/** The review after the reading: decisive questions and the location's documents. */
export const QUESTIONS_READY: IntakeView = { ...INTAKE_READY, locationRegister: REGISTER_READY }

/** The address was typed and no geocoder answered: the Bundesland and the Vorhaben are asked first. */
export const QUESTIONS_TYPED_ADDRESS: IntakeView = {
  ...INTAKE_READY,
  location: null,
  questions: [],
  openQuestions: [OPEN_PHASE],
  locationRegister: registerOf(profileOf({ standort_adresse: 'Hauptstraße 4, 3420 Kritzendorf' }), null),
}

/** Piloti still reads: the round says so and takes what is already known. */
export const QUESTIONS_READING: IntakeView = { ...INTAKE_READING, locationRegister: REGISTER_READY }

/** A past project: no Bundesland was found, so it is the one question; no document is requested. */
export const QUESTIONS_CLOSING: IntakeView = {
  ...INTAKE_CLOSING,
  location: null,
  locationRegister: registerOf(profileOf({ vorhabensart: ['neubau'] }), null, 'closing'),
}

/** Everything settled: every request has its values, every decisive question an answer. */
export const QUESTIONS_DONE: IntakeView = {
  ...INTAKE_READY,
  contradictions: [],
  questions: [],
  openQuestions: [],
  locationRegister: registerOf(
    profileOf(
      { ...VIENNA_STOREY_ADDITION, grundstueck_ez: 'EZ 1234, KG Hernals', 'denkmalschutz@bw1': 'nein' },
      { flaechenwidmung: 'wohngebiet', bebauungsplan: 'ja', gefahrenzonen: ['keine'], laermsituation: 'strasse' },
      ['grundstuecksflaeche']
    ),
    FIXTURE_LOCATION
  ),
}

export const QUESTIONS_FIXTURES = {
  ready: QUESTIONS_READY,
  'typed-address': QUESTIONS_TYPED_ADDRESS,
  reading: QUESTIONS_READING,
  closing: QUESTIONS_CLOSING,
  done: QUESTIONS_DONE,
} as const satisfies Record<string, IntakeView>

export type QuestionsFixtureName = keyof typeof QUESTIONS_FIXTURES
