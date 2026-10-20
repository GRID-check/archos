/**
 * The comparisons, in two files by kind: tools built for construction and
 * planning (comparison-construction.ts) and general AI assistants an office already
 * has (comparison-general.ts). The hub lists them in this order.
 */
import type { LandingEntry } from '../../lib/landing'
import { comparisonConstruction } from './comparison-construction'
import { comparisonGeneral } from './comparison-general'

export const comparison: LandingEntry[] = [...comparisonGeneral, ...comparisonConstruction]
