/**
 * The Ampel's reasons in the reader's language. `getApplicableStandards`
 * (`lib/oib/applicable-standards.ts`) writes each verdict's reason as one
 * fixed English sentence, shared with the overview and its Python twin; the
 * Steckbrief is German first, so each of those sentences has a key in
 * `intakeProfileStep.rules.reasons`. A sentence without a key (a new verdict
 * nobody translated yet) falls back to the status in words, never to English:
 * `standard-reasons.spec.ts` walks the verdicts and fails on the first one
 * missing here. Pure.
 */

import type { ApplicableStatus } from '@/lib/oib/applicable-standards'

export const STANDARD_REASON_IDS = [
  'structure',
  'fire',
  'hygiene',
  'access',
  'accessPublic',
  'soundOccupied',
  'soundRequired',
  'soundLikely',
  'energy',
  'energyExempt',
  'betriebsbau',
  'betriebsbauCheck',
  'garage',
  'hochhaus',
  'hochhausCheck',
] as const
export type StandardReasonId = (typeof STANDARD_REASON_IDS)[number]

const REASONS: Record<string, StandardReasonId> = {
  'Structural safety applies to every building.': 'structure',
  'General fire-safety requirements apply to every building.': 'fire',
  'Hygiene, daylight, ventilation and environmental requirements apply to every building.': 'hygiene',
  'Safety in use and barrier-free access apply.': 'access',
  'Safety in use and barrier-free access — accessibility duties are extensive for publicly used buildings.':
    'accessPublic',
  'Sound protection typically applies to occupied buildings.': 'soundOccupied',
  'Sound protection is required for occupied/noise-sensitive uses.': 'soundRequired',
  'Sound protection typically applies.': 'soundLikely',
  'Energy and thermal-performance requirements apply.': 'energy',
  'Unconditioned storage/agricultural buildings may be partly exempt from OIB 6.': 'energyExempt',
  'Manufacturing/storage use is a Betriebsbau.': 'betriebsbau',
  'Applies if the building qualifies as a Betriebsbau.': 'betriebsbauCheck',
  'Applies if the project includes a garage or covered parking.': 'garage',
  'Top escape level over 22 m — the building is a Hochhaus.': 'hochhaus',
  'GK5 building — confirm whether the top escape level exceeds 22 m.': 'hochhausCheck',
}

/** The key of a reason, or null for a sentence nobody translated yet. */
export function standardReasonId(reason: string): StandardReasonId | null {
  return REASONS[reason.trim()] ?? null
}

/** The short name a chip carries („OIB 2 Brandschutz"), by code; null for a code outside the catalog. */
export const STANDARD_SHORT_IDS = {
  'OIB 1': 'oib1',
  'OIB 2': 'oib2',
  'OIB 2.1': 'oib21',
  'OIB 2.2': 'oib22',
  'OIB 2.3': 'oib23',
  'OIB 3': 'oib3',
  'OIB 4': 'oib4',
  'OIB 5': 'oib5',
  'OIB 6': 'oib6',
} as const
export type StandardShortId = (typeof STANDARD_SHORT_IDS)[keyof typeof STANDARD_SHORT_IDS]

export function standardShortId(code: string): StandardShortId | null {
  return code in STANDARD_SHORT_IDS ? STANDARD_SHORT_IDS[code as keyof typeof STANDARD_SHORT_IDS] : null
}

/** Required first, then likely, then to check; the catalog's order within each. */
export function byStatus<T extends { status: ApplicableStatus }>(standards: readonly T[]): T[] {
  const order: Record<ApplicableStatus, number> = { required: 0, likely: 1, check: 2 }
  return standards
    .map((standard, index) => ({ standard, index }))
    .sort((a, b) => order[a.standard.status] - order[b.standard.status] || a.index - b.index)
    .map(({ standard }) => standard)
}
