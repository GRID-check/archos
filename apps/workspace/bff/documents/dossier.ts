/**
 * What ingestion knows about one document beyond its chunks, as the UI reads
 * it: the dossier (what the document is), the references it makes, and how
 * much of it was read (`docs/architecture/document-dossier.md`).
 *
 * The backend sends the three records snake_case on the collection listing as
 * `dossier`, `doc_references` and `coverage`. Declared here, beside the other
 * document wire types, so the BFF's reconciliation (`reconcile-status.ts`) and
 * the features layer (`FileItem`) import one shape. The parsers below are the
 * only place that maps them to camelCase and decides what is junk: a value
 * outside its vocabulary is dropped, never kept as free text, because two
 * documents can only contradict each other on a key both use.
 *
 * The vocabularies mirror `agent.knowledge.dossier` and
 * `knowledge_layer.references`; the contract doc is where both sides read them.
 */

/** What a document is (`dossier.document_type`). */
export const DOSSIER_DOCUMENT_TYPES = [
  'submission_drawing',
  'construction_drawing',
  'site_plan',
  'zoning_plan',
  'building_description',
  'fire_safety_concept',
  'structural_analysis',
  'energy_certificate',
  'building_physics',
  'soil_report',
  'expert_report',
  'permit',
  'application',
  'meeting_minutes',
  'correspondence',
  'offer',
  'invoice',
  'contract',
  'specification',
  'schedule',
  'calculation',
  'photo',
  'legal_text',
  'other',
] as const
export type DossierDocumentType = (typeof DOSSIER_DOCUMENT_TYPES)[number]

/** Who a party is to the document (`dossier.parties[].role`). */
export const DOSSIER_PARTY_ROLES = ['client', 'architect', 'engineer', 'authority', 'contractor', 'author', 'other'] as const
export type DossierPartyRole = (typeof DOSSIER_PARTY_ROLES)[number]

/** What a date on the document means (`dossier.dates[].kind`). */
export const DOSSIER_DATE_KINDS = ['issued', 'plan_date', 'received', 'valid_until', 'meeting', 'deadline', 'other'] as const
export type DossierDateKind = (typeof DOSSIER_DATE_KINDS)[number]

/** The facts a document can state about the building (`dossier.facts[].key`). */
export const DOSSIER_FACT_KEYS = [
  'building_class',
  'storeys_above_ground',
  'storeys_below_ground',
  'building_height',
  'gross_floor_area',
  'usable_floor_area',
  'plot_area',
  'floor_area_ratio',
  'site_coverage_ratio',
  'units',
  'parking_spaces',
  'use',
  'construction_method',
  'escape_route_length',
  'room_height',
  'energy_class',
  'heating_demand',
] as const
export type DossierFactKey = (typeof DOSSIER_FACT_KEYS)[number]

/** What a reference points at (`doc_references[].kind`). */
export const DOCUMENT_REFERENCE_KINDS = ['norm', 'law', 'plan', 'document'] as const
export type DocumentReferenceKind = (typeof DOCUMENT_REFERENCE_KINDS)[number]

/** Why pages went unread (`coverage.reasons` keys). */
export const COVERAGE_REASONS = ['render_cap', 'vision_failed', 'transcription_failed', 'transcription_cap', 'no_vision'] as const
export type CoverageReason = (typeof COVERAGE_REASONS)[number]

/** The contract's bounds; anything longer is cut, never trusted. */
export const DOSSIER_MAX_PARTIES = 8
export const DOSSIER_MAX_DATES = 8
export const DOSSIER_MAX_FACTS = 24
export const DOSSIER_MAX_QUOTE_LENGTH = 240
export const DOCUMENT_REFERENCES_MAX = 60
/** Fact changes a new Fassung's dossier carries at most (`dossier.MAX_CHANGES`). */
export const DOSSIER_MAX_CHANGES = 12
/** Not in the contract: a sane ceiling for text a person reads in a rail. */
const MAX_NAME_LENGTH = 200
const MAX_TITLE_LENGTH = 300
const MAX_SUMMARY_LENGTH = 2000
const MAX_VALUE_LENGTH = 120
const MAX_UNIT_LENGTH = 24
const MAX_REFERENCE_TEXT = 120
/** Pages a reference lists; the rail shows a handful, the finding a few more. */
const MAX_REFERENCE_PAGES = 50
const MAX_PAGE = 20_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface DossierParty {
  role: DossierPartyRole
  name: string
}

export interface DossierDate {
  kind: DossierDateKind
  /** ISO `YYYY-MM-DD`. */
  date: string
}

export interface DossierPlace {
  address?: string
  municipality?: string
  state?: string
}

export interface DossierFact {
  key: DossierFactKey
  /** As the document writes it, trimmed. */
  value: string
  unit: string | null
  /** 1-based page the fact was read on, or null when unknown. */
  page: number | null
  /** The document's own words the fact rests on, at most 240 characters. */
  quote: string | null
}

/**
 * One fact a new Fassung states differently from the one it replaced
 * (`dossier.fact_changes`): `before` null is newly stated, `after` null no
 * longer stated. Values carry their unit, as the documents write them.
 */
export interface DossierFactChange {
  key: DossierFactKey
  before: string | null
  after: string | null
  /** The page of the new Fassung that states it, or null. */
  page: number | null
}

export interface Dossier {
  documentType: DossierDocumentType | null
  title: string | null
  summary: string | null
  parties: DossierParty[]
  dates: DossierDate[]
  place: DossierPlace | null
  facts: DossierFact[]
  /**
   * What changed against the Fassung this one replaced, when that one had a
   * dossier too. Absent says nothing: a document ingested before the
   * comparison existed, or with no predecessor, carries none.
   */
  changes?: DossierFactChange[]
}

export interface DocumentReference {
  kind: DocumentReferenceKind
  /** Normalised by the extractor; for `document` a {@link DossierDocumentType}. */
  key: string
  /** As the document writes it. */
  label: string
  /** 1-based, ascending, distinct. */
  pages: number[]
}

export interface ReadingCoverage {
  pages: number
  text: number
  transcribed: number
  drawings: number
  drawingsRead: number
  notRead: number
  reasons: Partial<Record<CoverageReason, number>>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const boundedText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null
  const text = value.trim().slice(0, max).trim()
  return text.length > 0 ? text : null
}

const oneOf = <T extends string>(vocabulary: readonly T[], value: unknown): T | null =>
  typeof value === 'string' && (vocabulary as readonly string[]).includes(value) ? (value as T) : null

const usablePage = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PAGE ? value : null

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PAGE ? value : null

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function parseParty(raw: unknown): DossierParty | null {
  if (!isRecord(raw)) return null
  const role = oneOf(DOSSIER_PARTY_ROLES, raw.role)
  const name = boundedText(raw.name, MAX_NAME_LENGTH)
  return role && name ? { role, name } : null
}

function parseDate(raw: unknown): DossierDate | null {
  if (!isRecord(raw)) return null
  const kind = oneOf(DOSSIER_DATE_KINDS, raw.kind)
  const date = typeof raw.date === 'string' && ISO_DATE.test(raw.date) ? raw.date : null
  return kind && date ? { kind, date } : null
}

function parsePlace(raw: unknown): DossierPlace | null {
  if (!isRecord(raw)) return null
  const place: DossierPlace = {}
  const address = boundedText(raw.address, MAX_NAME_LENGTH)
  if (address) place.address = address
  const municipality = boundedText(raw.municipality, MAX_NAME_LENGTH)
  if (municipality) place.municipality = municipality
  const state = boundedText(raw.state, MAX_NAME_LENGTH)
  if (state) place.state = state
  return Object.keys(place).length > 0 ? place : null
}

function parseFact(raw: unknown): DossierFact | null {
  if (!isRecord(raw)) return null
  const key = oneOf(DOSSIER_FACT_KEYS, raw.key)
  // A number is a value too: the model may write `4` where the contract says `"4"`.
  const rawValue = typeof raw.value === 'number' && Number.isFinite(raw.value) ? String(raw.value) : raw.value
  const value = boundedText(rawValue, MAX_VALUE_LENGTH)
  if (!key || !value) return null
  return {
    key,
    value,
    unit: boundedText(raw.unit, MAX_UNIT_LENGTH),
    page: usablePage(raw.page),
    quote: boundedText(raw.quote, DOSSIER_MAX_QUOTE_LENGTH),
  }
}

function parseFactChange(raw: unknown): DossierFactChange | null {
  if (!isRecord(raw)) return null
  const key = oneOf(DOSSIER_FACT_KEYS, raw.key)
  const before = boundedText(raw.before, MAX_VALUE_LENGTH + MAX_UNIT_LENGTH + 1)
  const after = boundedText(raw.after, MAX_VALUE_LENGTH + MAX_UNIT_LENGTH + 1)
  if (!key || (before === null && after === null)) return null
  return { key, before, after, page: usablePage(raw.page) }
}

/** Parse each entry, keep what survives, stop at `max`. */
function boundedList<T>(raw: unknown, parse: (entry: unknown) => T | null, max: number): T[] {
  const parsed: T[] = []
  for (const entry of listOf(raw)) {
    if (parsed.length >= max) break
    const item = parse(entry)
    if (item) parsed.push(item)
  }
  return parsed
}

/**
 * Read a backend `dossier` object into a {@link Dossier}, or `null` when
 * nothing usable is left. Junk is dropped entry by entry: a party with an
 * unknown role does not cost the facts, and a fact outside the vocabulary is
 * simply absent.
 */
export function parseDossier(raw: unknown): Dossier | null {
  if (!isRecord(raw)) return null
  const dossier: Dossier = {
    documentType: oneOf(DOSSIER_DOCUMENT_TYPES, raw.document_type),
    title: boundedText(raw.title, MAX_TITLE_LENGTH),
    summary: boundedText(raw.summary, MAX_SUMMARY_LENGTH),
    parties: boundedList(raw.parties, parseParty, DOSSIER_MAX_PARTIES),
    dates: boundedList(raw.dates, parseDate, DOSSIER_MAX_DATES),
    place: parsePlace(raw.place),
    facts: boundedList(raw.facts, parseFact, DOSSIER_MAX_FACTS),
  }
  const seenChanges = new Set<string>()
  const changes = boundedList(
    raw.changes,
    (entry) => {
      const change = parseFactChange(entry)
      if (!change || seenChanges.has(change.key)) return null
      seenChanges.add(change.key)
      return change
    },
    DOSSIER_MAX_CHANGES
  )
  if (changes.length > 0) dossier.changes = changes
  const empty =
    !dossier.documentType &&
    !dossier.title &&
    !dossier.summary &&
    !dossier.place &&
    dossier.parties.length + dossier.dates.length + dossier.facts.length === 0
  return empty ? null : dossier
}

function parseReference(raw: unknown): DocumentReference | null {
  if (!isRecord(raw)) return null
  const kind = oneOf(DOCUMENT_REFERENCE_KINDS, raw.kind)
  const key = boundedText(raw.key, MAX_REFERENCE_TEXT)
  if (!kind || !key) return null
  // A document reference names a type; any other key is not one we can resolve.
  if (kind === 'document' && !oneOf(DOSSIER_DOCUMENT_TYPES, key)) return null
  const pages = [...new Set(listOf(raw.pages).map(usablePage).filter((page): page is number => page !== null))]
    .sort((a, b) => a - b)
    .slice(0, MAX_REFERENCE_PAGES)
  return { kind, key, label: boundedText(raw.label, MAX_REFERENCE_TEXT) ?? key, pages }
}

/**
 * Read a backend `doc_references` array into {@link DocumentReference}s, at
 * most {@link DOCUMENT_REFERENCES_MAX}, or `null` when none survives. A
 * duplicate `kind`+`key` keeps its first entry.
 */
export function parseDocumentReferences(raw: unknown): DocumentReference[] | null {
  const seen = new Set<string>()
  const references = boundedList(
    raw,
    (entry) => {
      const reference = parseReference(entry)
      if (!reference) return null
      const identity = `${reference.kind}\u0000${reference.key}`
      if (seen.has(identity)) return null
      seen.add(identity)
      return reference
    },
    DOCUMENT_REFERENCES_MAX
  )
  return references.length > 0 ? references : null
}

/**
 * Read a backend `coverage` object into a {@link ReadingCoverage}, or `null`
 * when it does not say how many pages there are. Counts that are not
 * non-negative integers read as 0; reasons outside the vocabulary are dropped.
 */
export function parseReadingCoverage(raw: unknown): ReadingCoverage | null {
  if (!isRecord(raw)) return null
  const pages = count(raw.pages)
  if (pages === null || pages === 0) return null
  const reasons: Partial<Record<CoverageReason, number>> = {}
  if (isRecord(raw.reasons)) {
    for (const reason of COVERAGE_REASONS) {
      const value = count(raw.reasons[reason])
      if (value) reasons[reason] = value
    }
  }
  return {
    pages,
    text: count(raw.text) ?? 0,
    transcribed: count(raw.transcribed) ?? 0,
    drawings: count(raw.drawings) ?? 0,
    drawingsRead: count(raw.drawings_read) ?? 0,
    notRead: Math.min(count(raw.not_read) ?? 0, pages),
    reasons,
  }
}
