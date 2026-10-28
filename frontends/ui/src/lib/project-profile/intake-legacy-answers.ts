/**
 * Reading profiles written before the current wizard: the bridges from legacy keys to today's answers.
 */

import type { ProjectPrimitiveValue, ProjectProfile } from './types'
import { type BuildingInstance, answerKeyFor, modeKeyFor } from './intake-building-keys'
import { isIntakeAnswerProvided } from './intake-conditions'

// ---------------------------------------------------------------------------
// Legacy bridges: v1.0-catalog profiles opened by the v1.2 catalog.
//
// Storage keys are id-independent, so the v1.1 renumbering costs nothing. What
// remains are the places where a MEANING moved: merged questions, the
// project→building scope move of the Bestand block, and the one inversion.
// Bridges only PREFILL wizard answers — the stored profile is untouched until
// the user saves, at which point the answers re-emit under the new shape and
// `mergeIntakeProfile` retires the intake-owned legacy keys.
// ---------------------------------------------------------------------------

/** The four v1.0 booleans that v1.2's `E2` multi-select absorbed. */
const LEGACY_TECHNOLOGY_KEYS = ['pv', 'ventilation', 'cooling', 'infiltration'] as const

/** v1.0 `work_type` (then `work_type`) → the v1.2 `CB4` measure it corresponds to. */
const LEGACY_PLANNED_WORK_TO_MEASURE: Record<string, string> = {
  refurbishment: 'envelope_refurbishment',
  conversion: 'interior_conversion',
  extension: 'extension',
  change_of_use: 'change_of_use',
  demolition: 'partial_demolition',
}

function legacyBoolean(profile: ProjectProfile, key: string): boolean | undefined {
  const value = profile.facts[key]?.value
  return typeof value === 'boolean' ? value : undefined
}

export function applyLegacyAnswerBridges(
  profile: ProjectProfile,
  answers: Record<string, ProjectPrimitiveValue>,
  buildings: BuildingInstance[]
): void {
  // --- Bestand block (v1.0 A6/A7/A9/A10 → CB1/CB3/CB5/CB6, project → building).
  // Only bridged into a single-building project: the legacy answer was one
  // project-global statement, and guessing WHICH of several buildings it
  // described would plant a wrong fact. Multi-building projects re-answer per
  // building; the completion checklist surfaces the gap.
  if (buildings.length === 1) {
    const buildingId = buildings[0].id
    const legacyExisting: Array<{ question: string; key: string; numeric: boolean }> = [
      { question: 'CB1', key: 'existing_year_built', numeric: true },
      { question: 'CB3', key: 'heritage_protection', numeric: false },
      { question: 'CB5', key: 'structural_intervention', numeric: false },
      { question: 'CB6', key: 'major_renovation', numeric: false },
    ]
    let bridgedAny = false
    for (const { question, key, numeric } of legacyExisting) {
      const answerKey = answerKeyFor(question, buildingId)
      if (answers[answerKey] !== undefined || answers[modeKeyFor(answerKey)] !== undefined) continue
      if (numeric) {
        const fact = profile.facts[key]?.value
        const assumption = profile.assumptions[key]?.value
        if (typeof fact === 'number') {
          answers[answerKey] = fact
          answers[modeKeyFor(answerKey)] = 'value'
          bridgedAny = true
        } else if (typeof assumption === 'number') {
          answers[answerKey] = assumption
          answers[modeKeyFor(answerKey)] = 'estimated'
          bridgedAny = true
        }
        continue
      }
      const bool = legacyBoolean(profile, key)
      if (bool !== undefined) {
        answers[answerKey] = bool ? 'yes' : 'no'
        bridgedAny = true
      } else if (profile.unknowns.includes(key)) {
        // An explicitly-open legacy answer is an answer. Dropping it left
        // `bridgedAny` false, so the C2 gate never opened and the whole
        // Bestand block stayed hidden for a project that had described one.
        answers[answerKey] = 'open'
        bridgedAny = true
      }
    }
    // A building whose Bestand was described IS a Bestandsgebäude — prefill the
    // gate so the bridged block is visible instead of orphaned behind an
    // unanswered C2.
    const c2Key = answerKeyFor('C2', buildingId)
    if (bridgedAny && answers[c2Key] === undefined) answers[c2Key] = 'existing'

    // CB6 sits behind a CB4 measure as well, and legacy profiles have no CB4.
    // Without one the bridged answer renders nowhere and `buildIntakeProfile`
    // drops it on save. The measures are read off the project's own
    // `work_type` rather than invented: v1.0 only ever ASKED A10 when A5
    // included `sanierung`, so the mapping restates what the old catalog
    // already implied.
    const cb4Key = answerKeyFor('CB4', buildingId)
    const cb6Key = answerKeyFor('CB6', buildingId)
    if (answers[cb6Key] !== undefined && !isIntakeAnswerProvided(answers[cb4Key])) {
      const plannedWork = profile.facts['work_type']?.value
      const measures = new Set<string>()
      if (Array.isArray(plannedWork)) {
        for (const workType of plannedWork) {
          const mapped = LEGACY_PLANNED_WORK_TO_MEASURE[String(workType)]
          if (mapped) measures.add(mapped)
        }
      }
      // CB6 only asks about the hull, so a bridged answer implies hull work
      // even when `work_type` named nothing that maps.
      if (measures.size === 0) measures.add('envelope_refurbishment')
      answers[cb4Key] = [...measures]
    }
  }

  for (const building of buildings) {
    // --- C8 inversion (v1.0 C7 `units_under_400`, ja = alle Einheiten bis 400 m²).
    const c8Key = answerKeyFor('C8', building.id)
    if (answers[c8Key] === undefined) {
      const legacy = profile.facts[`units_under_400@${building.id}`]?.value
      if (typeof legacy === 'boolean') answers[c8Key] = legacy ? 'no' : 'yes'
      else if (profile.unknowns.includes(`units_under_400@${building.id}`)) answers[c8Key] = 'open'
    }

    // --- C10 single → multi (`construction_method`): map the legacy single token.
    const c10Key = answerKeyFor('C10', building.id)
    const c10 = answers[c10Key]
    if (typeof c10 === 'string') {
      const mapped: Record<string, string[]> = {
        // `massivbau`, `stahl` and `hybrid` are v1.0 tokens no migration renamed
        // (they are no option of the current question); the others are the
        // current tokens, which is what a v1.0 profile holds after 0159.
        massivbau: ['masonry_solid'],
        timber: ['timber'],
        stahl: ['steel'],
        open: ['open'],
      }
      const replacement = mapped[c10]
      if (replacement) {
        answers[c10Key] = replacement
      } else if (c10 === 'hybrid') {
        // v1.0's `hybrid` named a combination without naming its members, and
        // v1.2 expresses a combination as the multi-select PLUS `C10_text`.
        // Deleting the answer dropped a construction type the user had actually
        // stated: `construction_method` is intake-owned, so `mergeIntakeProfile` removed
        // the stored fact too. It moves into the field built to hold exactly
        // this, and the user refines it when they next open the module.
        answers[c10Key] = ['open']
        const c10TextKey = answerKeyFor('C10_text', building.id)
        if (!isIntakeAnswerProvided(answers[c10TextKey])) {
          answers[c10TextKey] =
            'Hybridbauweise (aus früherer Angabe — Kombination bitte präzisieren)'
        }
      } else {
        delete answers[c10Key]
      }
    }

    // --- E2 fusion: four legacy booleans into `further_technology`.
    const e2Key = answerKeyFor('E2', building.id)
    if (answers[e2Key] === undefined) {
      const technology: string[] = []
      if (legacyBoolean(profile, `pv@${building.id}`)) technology.push('pv')
      if (legacyBoolean(profile, `ventilation@${building.id}`)) technology.push('ventilation')
      if (legacyBoolean(profile, `cooling@${building.id}`)) technology.push('cooling')
      if (legacyBoolean(profile, `infiltration@${building.id}`)) technology.push('infiltration')
      if (technology.length > 0) answers[e2Key] = technology
      else if (
        LEGACY_TECHNOLOGY_KEYS.every((key) => legacyBoolean(profile, `${key}@${building.id}`) === false)
      ) {
        // All four answered and all four "no" is the explicit `keine`, not an
        // unanswered question — otherwise the migration puts a module the user
        // completed back on the completion checklist.
        answers[e2Key] = ['none']
      }
    }
  }

  // --- B4 fusion: legacy Altlast/Baumbestand/Schutzgebiet booleans join the
  // stored `hazard_zones` values (already read into B4 — same key, wider
  // vocabulary).
  const b4Additions: string[] = []
  if (legacyBoolean(profile, 'contaminated_land')) b4Additions.push('contaminated_land')
  if (legacyBoolean(profile, 'tree_stock')) b4Additions.push('tree_stock')
  if (legacyBoolean(profile, 'protected_area')) b4Additions.push('protected_area')
  if (b4Additions.length > 0) {
    const current = Array.isArray(answers['B4']) ? (answers['B4'] as string[]) : []
    const merged = [
      ...current.filter((value) => value !== 'none'),
      ...b4Additions.filter((v) => !current.includes(v)),
    ]
    answers['B4'] = merged
  }

  // --- B6 fusion: Kanal + Trinkwasser + Zufahrt → one Erschließungs-Status.
  // Only when all three were answered; a partial picture stays unanswered
  // rather than guessed.
  if (answers['B6'] === undefined) {
    const sewer = legacyBoolean(profile, 'sewer')
    const water = legacyBoolean(profile, 'drinking_water')
    const access = legacyBoolean(profile, 'fire_brigade_access')
    if (sewer !== undefined && water !== undefined && access !== undefined) {
      const yes = [sewer, water, access].filter(Boolean).length
      // Never 'yes' from these three. The new question also covers electricity,
      // which v1.0 never asked, so claiming full servicing would persist a fact
      // nobody stated. Anything short of all three is honestly 'teilweise';
      // all three leaves the electricity question for the user.
      if (yes === 0) answers['B6'] = 'no'
      else if (yes < 3) answers['B6'] = 'partial'
    }
  }

  // --- B7 fusion: Anschlussgebiet beats bare availability.
  if (answers['B7'] === undefined) {
    if (legacyBoolean(profile, 'district_heating_zone')) answers['B7'] = 'connection_area'
    else {
      const fw = legacyBoolean(profile, 'district_heating')
      if (fw !== undefined) answers['B7'] = fw ? 'available' : 'unavailable'
    }
  }

  // v1.0's A8 (Schutzzone) is deliberately NOT bridged into `B3_bes`.
  //
  // `B3_bes` only renders behind `B2 = ja`, so a bridged value would be
  // invisible for a project with no Bebauungsplan — and then dropped on save,
  // because `buildIntakeProfile` skips a question whose condition is false.
  // Left alone, `old_town_protection_zone` is owned by no current question, so
  // `mergeIntakeProfile` preserves it as an agent-visible fact. Not bridging
  // keeps it; bridging lost it.

  // --- F4 fusion: legacy Zertifizierung tokens are valid F4 values.
  const zert = profile.facts['certification']?.value
  if (typeof zert === 'string' && !['none', 'open'].includes(zert)) {
    const current = Array.isArray(answers['F4']) ? (answers['F4'] as string[]) : []
    if (!current.includes(zert))
      answers['F4'] = [...current.filter((value) => value !== 'none'), zert]
  }

  // --- G merges: appended, never overwritten.
  const appendText = (answerKey: string, key: string) => {
    const legacy = profile.facts[key]?.value
    if (typeof legacy !== 'string' || !legacy.trim()) return
    const current = answers[answerKey]
    if (typeof current !== 'string' || !current.trim()) {
      answers[answerKey] = legacy
      return
    }
    // Idempotent. The legacy key is owned by no current question, so
    // `mergeIntakeProfile` preserves it — and the merged text is already in the
    // answer. Appending unconditionally added another copy on every reopen and
    // save, growing the field without bound.
    if (current.includes(legacy.trim())) return
    answers[answerKey] = `${current}\n\n${legacy}`
  }
  appendText('G1', 'context_plot')
  appendText('G4', 'context_other')
}
