/**
 * Every search page, by section. One file per section; see `src/lib/landing.ts`
 * for the shape and the rules.
 */
import type { LandingEntry, SectionId } from '../../lib/landing'
import { comparison } from './comparison'
import { useCases } from './use-cases'
import { audiences } from './audiences'
import { buildingLaw } from './building-law'
import { glossary } from './glossary'

export const LANDING: Record<SectionId, LandingEntry[]> = {
  vergleich: comparison,
  anwendungen: useCases,
  fuer: audiences,
  baurecht: buildingLaw,
  glossar: glossary,
}

/** An entry by `section/slug`, as `related` names it. */
export function landingEntry(ref: string): { section: SectionId; entry: LandingEntry } | undefined {
  const [section, slug] = ref.split('/') as [SectionId, string]
  const entry = LANDING[section]?.find((e) => e.slug === slug)
  return entry ? { section, entry } : undefined
}
