/**
 * The Gebäudeklasse derivation (`docs/design/agentic-project-intake.md`, „The
 * Gebäudeklasse derivation"): OIB-Richtlinien, Begriffsbestimmungen (Ausgabe
 * 2023). Data with its Fundstelle; the worked examples in
 * `src/aiq_agent/skills/builtin/oib/gebaeudeklasse/SKILL.md` are its test table.
 */

import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import type { DerivationRule } from './types'

export interface DerivationDefinition {
  rule: DerivationRule
  /** The Fundstelle the derivation's evidence names. */
  citation: string
  /** The base keys it reads, per Bauwerk. */
  inputs: readonly string[]
}

export interface GebaeudeklasseResult {
  /** The class, or null while an input is missing or for a Hochhaus. */
  value: 1 | 2 | 3 | 4 | 5 | null
  /** Fluchtniveau above 22 m: no Gebäudeklasse (OIB-RL 2.3). */
  hochhaus: boolean
  /** The base keys still needed. */
  missing: string[]
}

// TODO(slice 2, needs and derivation): the inputs and citation are the design's; fill in bands and spec.
export const GEBAEUDEKLASSE_DERIVATION: DerivationDefinition = {
  rule: 'gebaeudeklasse',
  citation: 'OIB-Richtlinien, Begriffsbestimmungen (Ausgabe 2023), „Gebäudeklassen"',
  inputs: [
    'bauwerkstyp',
    'gebaeudestellung',
    'geschosse_oberirdisch',
    'fluchtniveau_m',
    'nutzungseinheiten',
    'einheiten_ueber_400',
    'bgf_oberirdisch',
  ],
}

// TODO(slice 2, needs and derivation): implement and spec. Signature frozen by slice 0.
export function deriveGebaeudeklasse(inputs: Record<string, ProjectPrimitiveValue | undefined>): GebaeudeklasseResult {
  void inputs
  throw new Error('not implemented')
}
