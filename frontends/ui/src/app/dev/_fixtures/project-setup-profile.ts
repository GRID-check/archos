/**
 * Step 5, Steckbrief: fixtures for `/dev/project-setup?step=profile&state=<name>`
 * and the step's specs. They build on the review fixtures
 * (`project-intake.ts`), the Aufstockung in Wien, and add what this step shows
 * of its own: the rule set's Ampel as the server computes it
 * (`getApplicableStandards` over the confirmed values), a value two documents
 * agree on, a high-rise, and a Steckbrief with nothing left open.
 *
 *   - `review`: a contradiction, two decisive values to take one by one, the
 *     rest to take at once, the class suggested, the general list of Richtlinien
 *     (nothing decisive confirmed yet).
 *   - `confirmed`: every decisive value and the class taken, the rest still
 *     suggestions: the Ampel is the project's, and finishing is the next thing.
 *   - `hochhaus`: Bauwerk 1's Fluchtniveau is confirmed above 22 m, so it has
 *     no class and OIB-RL 2.3 is required.
 *   - `readonly`: the review for someone who may look but not decide.
 */

import { getApplicableStandards } from '@/lib/oib/applicable-standards'
import type { ProjectProfile } from '@/lib/project-profile/types'
import type { DerivationReview, IntakeView, Suggestion, SuggestionGroup } from '@/lib/project-intake/types'
import {
  DERIVATION_OPEN,
  DERIVATION_READY,
  fromDocument,
  INTAKE_READY,
  SUGGESTION_CLASS,
  SUGGESTION_ESCAPE_LEVEL,
  SUGGESTION_STOREYS,
  SUGGESTION_UNITS,
} from './project-intake'

const AT = '2026-10-14T08:30:00.000Z'

/** A profile holding exactly these confirmed values, for the Ampel the server would compute from it. */
function standardsFor(confirmed: Record<string, Suggestion['value']>): IntakeView['applicableStandards'] {
  const profile: ProjectProfile = {
    facts: Object.fromEntries(
      Object.entries(confirmed).map(([key, value]) => [
        key,
        { value, confidence: 'confirmed' as const, source: 'onboarding' as const, updatedAt: AT },
      ])
    ),
    goals: {},
    unknowns: [],
    assumptions: {},
  }
  return getApplicableStandards(profile)
}

const confirm = (item: Suggestion): Suggestion => ({ ...item, state: 'confirmed', alternatives: [], decisive: false })

/** The Fluchtniveau, read from the Schnitt and the Baubeschreibung alike: two sources agree. */
export const SUGGESTION_ESCAPE_LEVEL_CORROBORATED: Suggestion = {
  ...SUGGESTION_ESCAPE_LEVEL,
  evidence: [
    ...SUGGESTION_ESCAPE_LEVEL.evidence,
    fromDocument('Baubeschreibung.pdf', 2, 'Das Fluchtniveau des obersten Geschoßes liegt bei 18,40 m.'),
  ],
}

const withItems = (groups: readonly SuggestionGroup[], replace: (item: Suggestion) => Suggestion): SuggestionGroup[] =>
  groups.map((group) => ({ ...group, items: group.items.map(replace) }))

const REVIEW_GROUPS = withItems(INTAKE_READY.groups, (item) =>
  item.key === SUGGESTION_ESCAPE_LEVEL.key ? SUGGESTION_ESCAPE_LEVEL_CORROBORATED : item
)

/** The review as step 5 shows it: contradiction, decisive values, the rest, the class to take, the general Ampel. */
export const PROFILE_REVIEW: IntakeView = {
  ...INTAKE_READY,
  groups: REVIEW_GROUPS,
  applicableStandards: standardsFor({ standort_adresse: 'Lacknergasse 12, 1170 Wien', projektphase: 'einreichplanung' }),
}

const DECIDED = new Set([SUGGESTION_STOREYS.key, SUGGESTION_ESCAPE_LEVEL.key, SUGGESTION_UNITS.key])

const CLASS_CONFIRMED: DerivationReview = {
  ...DERIVATION_READY,
  inputs: DERIVATION_READY.inputs.map((input) => ({ ...input, suggested: input.key.startsWith('bauwerkstyp') })),
  suggestion: confirm(SUGGESTION_CLASS),
}

/** The decisive values and the class taken; the rest still suggestions; nothing open. */
export const PROFILE_CONFIRMED: IntakeView = {
  ...PROFILE_REVIEW,
  counts: { ...PROFILE_REVIEW.counts, contradictions: 0, decisiveOpen: 0, suggested: 3 },
  contradictions: [],
  questions: [],
  groups: withItems(REVIEW_GROUPS, (item) => (DECIDED.has(item.key) ? confirm(item) : item)),
  derivations: [CLASS_CONFIRMED],
  applicableStandards: standardsFor({
    'geschosse_oberirdisch@bw1': 6,
    'fluchtniveau_m@bw1': 18.4,
    'nutzungseinheiten@bw1': 14,
    'gebaeudeklasse@bw1': 5,
  }),
}

const ESCAPE_LEVEL_HIGH: Suggestion = {
  ...SUGGESTION_ESCAPE_LEVEL,
  value: 24.6,
  display: '24.6 m',
  state: 'confirmed',
  decisive: false,
  evidence: [fromDocument('E-02 Schnitt A-A.pdf', 1, 'Fluchtniveau +24,60 m über Gelände')],
}

/** Bauwerk 1 is a high-rise: no class, OIB-RL 2.3 required. */
export const PROFILE_HOCHHAUS: IntakeView = {
  ...PROFILE_CONFIRMED,
  groups: withItems(PROFILE_CONFIRMED.groups, (item) => (item.key === ESCAPE_LEVEL_HIGH.key ? ESCAPE_LEVEL_HIGH : item)),
  derivations: [
    {
      ...DERIVATION_READY,
      value: null,
      hochhaus: true,
      inputs: DERIVATION_READY.inputs.map((input) =>
        input.key === ESCAPE_LEVEL_HIGH.key ? { ...input, value: 24.6, suggested: false } : input
      ),
      suggestion: null,
    },
    DERIVATION_OPEN,
  ],
  applicableStandards: standardsFor({ 'fluchtniveau_m@bw1': 24.6 }),
}

/** Someone who may look at the Steckbrief but not decide on it. */
export const PROFILE_READONLY: IntakeView = { ...PROFILE_REVIEW, canDecide: false, canComplete: false }

export const PROFILE_STEP_FIXTURES = {
  review: PROFILE_REVIEW,
  confirmed: PROFILE_CONFIRMED,
  hochhaus: PROFILE_HOCHHAUS,
  readonly: PROFILE_READONLY,
} as const

export type ProfileStepFixtureName = keyof typeof PROFILE_STEP_FIXTURES
