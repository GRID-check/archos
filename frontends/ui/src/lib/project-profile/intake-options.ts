/**
 * Option lists and source labels the wizard's questions share.
 */

import type { ProjectIntakeOption } from './intake-types'

/** The use-catalog (D0), reused for both the multi-select and the zone expansion. */
export const USES: ProjectIntakeOption[] = [
  { value: 'residential', label: 'Wohnen' },
  { value: 'office', label: 'Büro / Verwaltung' },
  { value: 'retail', label: 'Handel / Verkauf' },
  { value: 'catering', label: 'Gastronomie' },
  { value: 'lodging', label: 'Beherbergung' },
  { value: 'assembly', label: 'Versammlung / Veranstaltung' },
  { value: 'education', label: 'Bildung / Betreuung' },
  { value: 'healthcare', label: 'Gesundheit / Pflege' },
  { value: 'production', label: 'Produktion / Gewerbe / Lager' },
  { value: 'garage', label: 'Garage / Stellplätze' },
  { value: 'agriculture', label: 'Landwirtschaft' },
  { value: 'technical', label: 'Technik / Sonstiges' },
]

/**
 * Where a value is usually stated, by the document kinds of an Austrian
 * planning office. One name per kind, so the agent and a Rückfrage say the
 * same thing for the same document.
 */
export const FOUND_IN = {
  titleBlock: 'Einreichplan (Plankopf)',
  siteLayout: 'Lageplan',
  submissionSiteLayout: 'Einreichplan (Lageplan)',
  floorLayout: 'Einreichplan (Grundriss)',
  section: 'Einreichplan (Schnitt)',
  elevation: 'Einreichplan (Ansicht)',
  buildingDescription: 'Baubeschreibung',
  permit: 'Bescheid',
  landRegister: 'Grundbuchauszug',
  zoning: 'Flächenwidmungsplan',
  developmentPlan: 'Bebauungsplan (Plandokument)',
  energyCertificate: 'Energieausweis',
  fireSafety: 'Brandschutzkonzept',
  structural: 'Statik',
  // The location register's documents (`lib/project-intake/location-register.ts`).
  hazardZonePlan: 'Gefahrenzonenplan',
  contaminatedSites: 'Altlasten-Auskunft (Verdachtsflächenkataster)',
  noise: 'Lärmgutachten',
  heritageList: 'Denkmalliste (Bundesdenkmalamt)',
} as const
