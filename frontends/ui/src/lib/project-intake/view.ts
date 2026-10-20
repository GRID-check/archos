/**
 * The review as `GET /api/projects/[id]/intake` answers it (ADR-0111): the
 * intake row, the profile as it stands and the needs computed from it, turned
 * into an `IntakeView`. Pure; the service loads, this shapes.
 *
 * Every fact and suggestion under a key one of the wizard's questions writes
 * is shown in that question's module, with where it was found and what else
 * was found for it. A value with alternatives is a contradiction, listed again
 * on top. The questions are the decisive needs nothing has filled (a
 * `suggested` or `confirmed` need is not a question). The class of each
 * building is shown once, in `derivations`, with the inputs it read and the
 * ones it lacks, never again in the modules; a contested class is still listed
 * among the contradictions.
 */

import {
  formatIntakeAnswer,
  labelForProfileKey,
  type ProjectIntakeDefinition,
  type ProjectIntakeQuestion,
  type ProjectIntakeStage,
} from '@/lib/project-profile/intake-definition'
import type { ProjectAssumption, ProjectFact, ProjectProfile } from '@/lib/project-profile/types'
import type { ProjectIntakeRow } from '@/lib/db/schema/project-intakes'
import { getApplicableStandards } from '@/lib/oib/applicable-standards'
import { deriveAll } from './derivation-view'
import { locationRegisterFor } from './location-register'
import { BUILDING_CLASS_DERIVATION } from './derivations'
import { profileKeyParts } from './profile-edits'
import {
  MAX_INTAKE_NEEDS,
  type DerivationReview,
  type IntakeCounts,
  type IntakeView,
  type Need,
  type ReadingProgress,
  type Suggestion,
  type SuggestionGroup,
  type SuggestionState,
} from './types'

/** Where a base key is asked: its module, and the question (none for a derived key). */
interface KeyHome {
  stage: ProjectIntakeStage
  question: ProjectIntakeQuestion | null
}

function stageQuestions(stage: ProjectIntakeStage): ProjectIntakeQuestion[] {
  return [
    ...stage.questions,
    ...(stage.zoneCommon ?? []),
    ...Object.values(stage.zoneDefinitions ?? {}).flatMap((zone) => zone.questions),
  ]
}

/** Base key → its module and question, from the definition: the profile keys questions write, and the derived ones. */
export function keyHomes(definition: ProjectIntakeDefinition): Map<string, KeyHome> {
  const homes = new Map<string, KeyHome>()
  for (const stage of definition.stages) {
    for (const question of stageQuestions(stage)) {
      const written = /^\/facts\/([^/]+)/.exec(question.writesTo ?? '')?.[1]
      if (written && !homes.has(written)) homes.set(written, { stage, question })
      if (question.derives === BUILDING_CLASS_DERIVATION.rule && !homes.has(question.derives)) {
        homes.set(question.derives, { stage, question })
      }
    }
  }
  return homes
}

function displayOf(home: KeyHome, value: ProjectFact['value']): string {
  const { question } = home
  if (question?.derives === BUILDING_CLASS_DERIVATION.rule) return `GK ${String(value)}`
  return question ? formatIntakeAnswer(question, value) : String(value)
}

function stateOf(entry: ProjectFact | ProjectAssumption, confirmed: boolean): SuggestionState {
  if (entry.alternatives && entry.alternatives.length > 0) return 'contested'
  return confirmed ? 'confirmed' : 'suggested'
}

function suggestionOf(
  key: string,
  entry: ProjectFact | ProjectAssumption,
  confirmed: boolean,
  home: KeyHome,
  definition: ProjectIntakeDefinition,
  decisive: ReadonlySet<string>
): Suggestion {
  const { baseKey, buildingId } = profileKeyParts(key)
  const label = home.question?.derives ? home.question.label : labelForProfileKey(definition, key)
  return {
    key,
    baseKey,
    bauwerkId: buildingId,
    label,
    value: entry.value,
    display: displayOf(home, entry.value),
    state: stateOf(entry, confirmed),
    evidence: entry.evidence ?? [],
    alternatives: entry.alternatives ?? [],
    decisive: decisive.has(key),
  }
}

/** Every value on the profile under a key the definition knows, with the module it belongs to, facts first. */
function profileItems(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
  needs: readonly Need[]
): Array<{ stage: string; item: Suggestion }> {
  const homes = keyHomes(definition)
  const decisive = new Set(needs.filter((need) => need.decisive).map((need) => need.key))
  const items: Array<{ stage: string; item: Suggestion }> = []
  const add = (key: string, entry: ProjectFact | ProjectAssumption, confirmed: boolean) => {
    const home = homes.get(profileKeyParts(key).baseKey)
    if (home) items.push({ stage: home.stage.id, item: suggestionOf(key, entry, confirmed, home, definition, decisive) })
  }
  for (const [key, fact] of Object.entries(profile.facts)) add(key, fact, true)
  for (const [key, assumption] of Object.entries(profile.assumptions)) {
    if (!(key in profile.facts)) add(key, assumption, false)
  }
  return items
}

/** The derived class: shown and decided in `derivations`, so not again in its module. */
const isDerivedClass = (item: Suggestion) => item.baseKey === BUILDING_CLASS_DERIVATION.rule

/** Every value on the profile under a key the definition knows, grouped by module in the wizard's order; the derived class is not among them. */
export function suggestionGroups(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
  needs: readonly Need[]
): SuggestionGroup[] {
  const byStage = new Map<string, Suggestion[]>()
  for (const { stage, item } of profileItems(profile, definition, needs)) {
    if (isDerivedClass(item)) continue
    byStage.set(stage, [...(byStage.get(stage) ?? []), item])
  }
  return definition.stages
    .filter((stage) => byStage.has(stage.id))
    .map((stage) => ({ stage: stage.id, title: stage.title, items: byStage.get(stage.id) ?? [] }))
}

/** Each building's derivation, with the suggestion of its class: the row the review confirms it through. */
function derivationReviews(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
  needs: readonly Need[]
): DerivationReview[] {
  const classes = new Map(
    profileItems(profile, definition, needs)
      .filter(({ item }) => isDerivedClass(item))
      .map(({ item }) => [item.key, item])
  )
  return deriveAll(profile, definition).map((derivation) => ({
    ...derivation,
    suggestion: classes.get(`${BUILDING_CLASS_DERIVATION.rule}@${derivation.bauwerkId}`) ?? null,
  }))
}

/** The values with a different value found beside them, in the modules' order, the derived class included. */
function contestedItems(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
  needs: readonly Need[]
): Suggestion[] {
  const order = new Map(definition.stages.map((stage, index) => [stage.id, index]))
  return profileItems(profile, definition, needs)
    .filter(({ item }) => item.state === 'contested')
    .sort((a, b) => (order.get(a.stage) ?? 0) - (order.get(b.stage) ?? 0))
    .map(({ item }) => item)
}

/** What a reading leaves to review, counted as the row stores it at the end of a reading. */
export function intakeCounts(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
  needs: readonly Need[],
  documentsRead: number
): IntakeCounts {
  return {
    documentsRead,
    suggested: Object.values(profile.assumptions).filter((entry) => entry.source === 'agent_suggested').length,
    contradictions: contestedItems(profile, definition, needs).length,
    decisiveOpen: needs.filter((need) => need.decisive && need.state === 'open').length,
  }
}

export interface IntakeViewInput {
  row: ProjectIntakeRow
  profile: ProjectProfile
  definition: ProjectIntakeDefinition
  needs: readonly Need[]
  unreadDocuments: number
  canDecide: boolean
  canComplete: boolean
  /** Step 3: the readable documents and the unread ones among them, for the live „x von y". Absent: none. */
  readingDocuments?: { readable: readonly ReadingDocument[]; unread: readonly ReadingDocument[] }
}

const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null

/** The review. */
export function buildIntakeView(input: IntakeViewInput): IntakeView {
  const { row, profile, definition, needs } = input
  const groups = suggestionGroups(profile, definition, needs)
  const contradictions = contestedItems(profile, definition, needs)
  const questions = needs.filter((need) => need.decisive && need.state === 'open').slice(0, MAX_INTAKE_NEEDS)
  const openQuestions = needs.filter((need) => !need.decisive && need.state === 'open').slice(0, MAX_INTAKE_NEEDS)
  const counts = intakeCounts(profile, definition, needs, row.documentsRead.length)
  return {
    projectId: row.projectId,
    status: row.status,
    mode: row.mode,
    description: row.description ?? null,
    location: row.location ?? null,
    closing: row.closing ?? null,
    counts: { ...counts, unreadDocuments: input.unreadDocuments },
    readingStartedAt: iso(row.startedAt),
    readingFinishedAt: iso(row.finishedAt),
    summary: row.summary ?? null,
    contradictions,
    questions,
    openQuestions,
    groups,
    derivations: derivationReviews(profile, definition, needs),
    canDecide: input.canDecide,
    canComplete: input.canComplete,
    // Step 5, Steckbrief: the Ampel from the confirmed values (facts) only.
    applicableStandards: getApplicableStandards(profile),
    // Step 4, Rückfragen: what the location decides, and the documents for it.
    locationRegister: locationRegisterFor({ profile, location: row.location ?? null, mode: row.mode, needs }),
    readingProgress: readingProgressOf(input),
  }
}

// ---------------------------------------------------------------------------
// Step 3, Erfassung (`reading`): the reading's live milestones
// ---------------------------------------------------------------------------

/** A readable document, as far as the reading's progress needs one. */
export interface ReadingDocument {
  documentId: string
  fileName: string
}

/**
 * How far the current or last reading got through what it had before it.
 * Opened: the readable documents whose name the run reported opening (the
 * finish merges by name too, `mergeDocumentsRead`). Before it: the documents
 * no finished reading has read, and the ones it opened (a reading may open a
 * document read before, and then it counts on both sides). Pure.
 */
export function readingDocumentProgress(
  readingFiles: readonly string[],
  readable: readonly ReadingDocument[],
  unread: readonly ReadingDocument[]
): Pick<ReadingProgress, 'documentsOpened' | 'documentsTotal'> {
  const named = new Set(readingFiles)
  const before = new Set(unread.map((document) => document.documentId))
  let documentsOpened = 0
  for (const document of readable) {
    if (!named.has(document.fileName)) continue
    documentsOpened += 1
    before.add(document.documentId)
  }
  return { documentsOpened, documentsTotal: before.size }
}

type SiteSource = NonNullable<ReadingProgress['site']['source']>

/** Where a Bundesland came from: the address search at creation, a document, or a person. */
function siteSource(entry: ProjectFact | ProjectAssumption, confirmed: boolean, row: ProjectIntakeRow): SiteSource {
  if (confirmed && row.location?.federalState === entry.value) return 'geocoder'
  const kinds = new Set((entry.evidence ?? []).map((evidence) => evidence.kind))
  if (kinds.has('document')) return 'document'
  if (kinds.has('geocoder')) return 'geocoder'
  return 'person'
}

/**
 * „Standort ermittelt": the Bundesland as a person reads it, the Gemeinde the
 * address search named, and the address, from the profile first (what a
 * reading found or a person said) and the intake's geocoder result second.
 * Pure.
 */
export function readingSite(
  row: ProjectIntakeRow,
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition
): ReadingProgress['site'] {
  const homes = keyHomes(definition)
  const shown = (key: string, value: ProjectFact['value']) => {
    const home = homes.get(key)
    return home ? displayOf(home, value) : String(value)
  }
  const fact = profile.facts.federal_state
  const entry = fact ?? profile.assumptions.federal_state
  const address = profile.facts.site_address ?? profile.assumptions.site_address
  const addressText = address ? String(address.value) : (row.location?.label ?? null)
  return {
    federalState: entry ? shown('federal_state', entry.value).slice(0, 200) : null,
    municipality: row.location?.municipality?.slice(0, 200) ?? null,
    address: addressText ? addressText.slice(0, 500) : null,
    source: entry ? siteSource(entry, Boolean(fact), row) : null,
    confirmed: Boolean(fact),
  }
}

/** Step 3's block of the view. */
function readingProgressOf(input: IntakeViewInput): ReadingProgress {
  const documents = input.readingDocuments ?? { readable: [], unread: [] }
  return {
    ...readingDocumentProgress(input.row.readingFiles ?? [], documents.readable, documents.unread),
    site: readingSite(input.row, input.profile, input.definition),
  }
}
