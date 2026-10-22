/**
 * Derive which OIB-Richtlinien apply to a project from the project's own brief
 * (its {@link ProjectProfile}). Pure and isomorphic — safe to run on the server
 * (Overview query) or the client. No I/O, no side effects.
 *
 * The result is orientation, not legal advice: it maps a handful of the brief's
 * facts (main use, building class, escape level, storeys) onto the Richtlinien
 * and explains, in one line, why each is relevant.
 *
 * What it reads. The intake wizard stores a building's facts under a suffix per
 * building (`escape_level_m@bldg1`), so every read takes the flat key and each
 * `<key>@<bldgN>` copy. A use zone's copy (`<key>@bldg1@residential`) is that zone's detail
 * and is skipped.
 *   - `main_use`: stated flat; else the one D0 use the buildings share
 *     (`uses`) that is also a verdict token. Two or more, or none: unknown.
 *   - `building_class`: `4` or `GK4`; the highest class across the buildings.
 *   - `escape_level`: the band stated flat; else the band of the highest
 *     `escape_level_m` (metres) across the buildings.
 *   - `storeys_below_ground`: the highest count across the buildings.
 * The Python twin, `src/aiq_agent/common/applicability.py`, reads the same keys
 * from the prompt view and must give the same verdicts.
 */

import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import { getOibStandard, OIB_STANDARDS } from './standards-catalog'

/** How strongly a Richtlinie applies, given what the brief tells us. */
export type ApplicableStatus = 'required' | 'likely' | 'check'

/** A catalog entry annotated with a project-specific applicability verdict. */
export interface ApplicableStandard {
  code: string
  titleEn: string
  titleDe: string
  scope: string
  oibUrl: string
  status: ApplicableStatus
  reason: string
  /**
   * For a `check`: the profile key whose answer would settle it (`escape_level`
   * decides whether a GK5 building is a Hochhaus). Absent for the other verdicts.
   */
  decidingFact?: string
}

/** Build an {@link ApplicableStandard} from a catalog code + a verdict. */
function annotate(
  code: string,
  status: ApplicableStatus,
  reason: string,
  decidingFact?: string
): ApplicableStandard {
  const entry = getOibStandard(code)
  if (!entry) {
    // Every code passed here is a literal from the catalog, so this is unreachable
    // in practice; we fail soft rather than throw so the Overview never breaks.
    return { code, titleEn: code, titleDe: code, scope: '', oibUrl: '', status, reason }
  }
  return {
    code: entry.code,
    titleEn: entry.titleEn,
    titleDe: entry.titleDe,
    scope: entry.scope,
    oibUrl: entry.oibUrl,
    status,
    reason,
    ...(decidingFact ? { decidingFact } : {}),
  }
}

/** Every fact value stored under a base key: the flat key and each `<key>@bldgN` copy. */
function factValuesByBase(profile: ProjectProfile | null, base: string): ProjectPrimitiveValue[] {
  const facts = profile?.facts ?? {}
  return Object.keys(facts)
    .filter((name) => {
      const [key, , zone] = name.split('@')
      return key === base && zone === undefined
    })
    .map((name) => facts[name]?.value)
    .filter((value): value is ProjectPrimitiveValue => value !== undefined)
}

/** A stated flat fact as a string, defensively. An empty string is no answer. */
function factString(profile: ProjectProfile | null, id: string): string | undefined {
  const value = profile?.facts?.[id]?.value
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A fact value as a finite number, as the Python twin reads it. Booleans are never numbers. */
function asNumber(value: ProjectPrimitiveValue | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const n = Number(value.trim())
  return Number.isFinite(n) ? n : undefined
}

/** The largest of the defined numbers, or undefined when there are none. */
function maxNumber(values: ReadonlyArray<number | undefined>): number | undefined {
  const defined = values.filter((n): n is number => n !== undefined)
  return defined.length > 0 ? Math.max(...defined) : undefined
}

/**
 * The Fluchtniveau band the rules read: the stated `escape_level`, else the band of
 * the highest `escape_level_m` across the buildings. Each band takes its upper bound
 * inclusively: exactly 7 m is `<=7m`, 11 m is `7-11m`, 22 m is `11-22m`.
 */
export function escapeLevelBand(profile: ProjectProfile | null): string | undefined {
  const stated = factString(profile, 'escape_level')
  if (stated !== undefined) return stated
  const metres = maxNumber(factValuesByBase(profile, 'escape_level_m').map(asNumber))
  if (metres === undefined) return undefined
  if (metres <= 7) return '<=7m'
  if (metres <= 11) return '7-11m'
  if (metres <= 22) return '11-22m'
  return '>22m'
}

/**
 * The tokens the verdicts compare `main_use` against: the union of the tokens in
 * the comparisons below. The D0 catalogue (`intake-definition.ts`) shares only
 * some of them (`residential`, `office`, `lodging`, `assembly`, `healthcare`,
 * `agriculture`). `manufacturing`, `storage` and `other` are never a D0 token,
 * and `production` is not `manufacturing`, so no mapping between them is invented.
 */
const MAIN_USE_TOKENS: ReadonlySet<string> = new Set([
  'manufacturing',
  'storage',
  'agriculture',
  'other',
  'residential',
  'lodging',
  'healthcare',
  'assembly',
  'office',
])

/**
 * The main use: the stated `main_use`; else, only when the buildings' `uses`
 * together name exactly one verdict token, that token. Two or none: unknown.
 */
function mainUseOf(profile: ProjectProfile | null): string | undefined {
  const stated = factString(profile, 'main_use')
  if (stated !== undefined) return stated
  const uses = new Set(
    factValuesByBase(profile, 'uses').flatMap((value) =>
      Array.isArray(value) ? value.map((token) => token.trim()) : []
    )
  )
  // Every use must name a verdict token: a use outside the vocabulary
  // (`production`) is unknown, and an unknown use may be the Betriebsbau.
  if (uses.size !== 1) return undefined
  const [only] = uses
  return MAIN_USE_TOKENS.has(only) ? only : undefined
}

/** `4` or `GK4` (either case) as its class number, else undefined. */
function buildingClassNumber(value: ProjectPrimitiveValue): number | undefined {
  if (typeof value === 'number') return [1, 2, 3, 4, 5].includes(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const match = /^(?:GK)?([1-5])$/.exec(value.trim().toUpperCase())
  return match ? Number(match[1]) : undefined
}

/** The building class across the buildings: the highest class named, as `GK<n>`. */
function buildingClassOf(profile: ProjectProfile | null): string | undefined {
  const top = maxNumber(factValuesByBase(profile, 'building_class').map(buildingClassNumber))
  return top === undefined ? undefined : `GK${top}`
}

/** The six Richtlinien that apply to essentially every building, as generic 'required'. */
function genericSix(): ApplicableStandard[] {
  return [
    annotate('OIB 1', 'required', 'Structural safety applies to every building.'),
    annotate('OIB 2', 'required', 'General fire-safety requirements apply to every building.'),
    annotate(
      'OIB 3',
      'required',
      'Hygiene, daylight, ventilation and environmental requirements apply to every building.'
    ),
    annotate('OIB 4', 'required', 'Safety in use and barrier-free access apply.'),
    annotate('OIB 5', 'required', 'Sound protection typically applies to occupied buildings.'),
    annotate('OIB 6', 'required', 'Energy and thermal-performance requirements apply.'),
  ]
}

/**
 * Return only the Richtlinien that are required / likely / worth checking for this
 * project — clearly-inapplicable ones are omitted. When the brief is empty we can
 * only speak generically, so we return the six near-universal Richtlinien as
 * 'required' and let the UI prompt the architect to complete the brief.
 */
export function getApplicableStandards(profile: ProjectProfile | null): ApplicableStandard[] {
  const hasFacts = profile?.facts != null && Object.keys(profile.facts).length > 0
  if (!hasFacts) {
    return genericSix()
  }

  const mainUse = mainUseOf(profile)
  const buildingClass = buildingClassOf(profile)
  const escapeLevel = escapeLevelBand(profile)
  const storeysBelowGround = maxNumber(
    factValuesByBase(profile, 'storeys_below_ground').map(asNumber)
  )

  const standards: ApplicableStandard[] = []

  // OIB 1 — always.
  standards.push(annotate('OIB 1', 'required', 'Structural safety applies to every building.'))

  // OIB 2 — always.
  standards.push(
    annotate('OIB 2', 'required', 'General fire-safety requirements apply to every building.')
  )

  // OIB 2.1 — Betriebsbauten (industrial & commercial).
  if (mainUse === 'manufacturing' || mainUse === 'storage') {
    standards.push(
      annotate('OIB 2.1', 'required', 'Manufacturing/storage use is a Betriebsbau.')
    )
  } else if (
    mainUse === 'agriculture' ||
    mainUse === 'other' ||
    mainUse === undefined
  ) {
    standards.push(
      annotate('OIB 2.1', 'check', 'Applies if the building qualifies as a Betriebsbau.', 'main_use')
    )
  }
  // else: omit (clearly not a Betriebsbau).

  // OIB 2.2 — garages & covered parking.
  if (storeysBelowGround !== undefined && storeysBelowGround >= 1) {
    standards.push(
      annotate(
        'OIB 2.2',
        'check',
        'Applies if the project includes a garage or covered parking.',
        'uses'
      )
    )
  }
  // else: omit.

  // OIB 2.3 — high-rise (Hochhaus).
  if (escapeLevel === '>22m') {
    standards.push(
      annotate('OIB 2.3', 'required', 'Top escape level over 22 m — the building is a Hochhaus.')
    )
  } else if (buildingClass === 'GK5' && escapeLevel === undefined) {
    standards.push(
      annotate(
        'OIB 2.3',
        'check',
        'GK5 building — confirm whether the top escape level exceeds 22 m.',
        'escape_level'
      )
    )
  }
  // else: omit.

  // OIB 3 — always.
  standards.push(
    annotate(
      'OIB 3',
      'required',
      'Hygiene, daylight, ventilation and environmental requirements apply to every building.'
    )
  )

  // OIB 4 — always; stronger for publicly used buildings.
  const publicUse =
    mainUse === 'lodging' ||
    mainUse === 'healthcare' ||
    mainUse === 'assembly' ||
    mainUse === 'office'
  standards.push(
    annotate(
      'OIB 4',
      'required',
      publicUse
        ? 'Safety in use and barrier-free access — accessibility duties are extensive for publicly used buildings.'
        : 'Safety in use and barrier-free access apply.'
    )
  )

  // OIB 5 — sound protection; required for occupied/noise-sensitive uses.
  const noiseSensitive =
    mainUse === 'residential' ||
    mainUse === 'lodging' ||
    mainUse === 'healthcare' ||
    mainUse === 'office' ||
    mainUse === 'assembly'
  standards.push(
    noiseSensitive
      ? annotate('OIB 5', 'required', 'Sound protection is required for occupied/noise-sensitive uses.')
      : annotate('OIB 5', 'likely', 'Sound protection typically applies.')
  )

  // OIB 6 — energy & thermal performance; storage/agricultural may be partly exempt.
  if (mainUse === 'storage' || mainUse === 'agriculture') {
    standards.push(
      annotate(
        'OIB 6',
        'check',
        'Unconditioned storage/agricultural buildings may be partly exempt from OIB 6.',
        'main_use'
      )
    )
  } else {
    standards.push(
      annotate('OIB 6', 'required', 'Energy and thermal-performance requirements apply.')
    )
  }

  return standards
}

/** Re-exported for callers that want the full catalog alongside the verdicts. */
export { OIB_STANDARDS }
