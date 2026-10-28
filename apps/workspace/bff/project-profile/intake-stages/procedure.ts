/** Stage F, Verfahren & Sonderrecht: the permit procedure and special law. */

import type { ProjectIntakeStage } from '../intake-types'

export const PROCEDURE_STAGE: ProjectIntakeStage = {
  id: 'F',
  title: 'Verfahren & Sonderrecht',
  scope: 'project',
  description:
    'Behördenverfahren, Förderungen und Sonderthemen — im Zielsystem großteils vorbelegt, hier bestätigen.',
  questions: [
    {
      id: 'F1',
      label: 'Gewerbliche Betriebsanlage?',
      type: 'yes_no_open',
      why: 'Betriebsanlagen benötigen ein Genehmigungsverfahren nach der Gewerbeordnung, parallel zur Baubewilligung.',
      hint: 'Im echten System aus den Nutzungen vorbelegt.',
      writesTo: '/facts/commercial_facility/value',
    },
    {
      id: 'F2',
      label: 'UVP-Relevanz',
      type: 'info_placeholder',
      derives: 'uvp',
      hint: 'Das System prüft anhand Ihrer Angaben die Schwellenwerte des UVP-Gesetzes (Stellplätze gesamt, Verkaufsflächen, Städtebauvorhaben) und zeigt an, ob eine Umweltverträglichkeitsprüfung nötig sein könnte.',
    },
    {
      id: 'F3',
      label: 'Wasserrechtliche Bewilligung voraussichtlich nötig?',
      type: 'yes_no_open',
      hint: 'Vorbelegt aus Standortrisiken (B4) und Versickerung (E2).',
      writesTo: '/facts/water_rights/value',
    },
    {
      // v1.0's F4 (Förderung) + F5 (Zertifizierung) as one multi-select.
      // The storage key stays `funding`: old values are a subset, and
      // the legacy `certification` single-select is bridged in.
      id: 'F4',
      label: 'Förderung oder Zertifizierung angestrebt?',
      type: 'multi_select',
      optional: true,
      why: 'Förderungen und Zertifizierungen bringen oft eigene, teils strengere Anforderungen mit.',
      options: [
        { value: 'housing_subsidy', label: 'Wohnbauförderung des Landes' },
        { value: 'refurbishment_subsidy', label: 'Sanierungsförderung' },
        { value: 'klimaaktiv', label: 'klimaaktiv' },
        { value: 'oegni_dgnb', label: 'ÖGNI / DGNB' },
        { value: 'leed_breeam', label: 'LEED / BREEAM' },
        { value: 'none', label: 'keine' },
        { value: 'open', label: 'noch offen' },
      ],
      writesTo: '/facts/funding/value',
    },
    {
      id: 'F5',
      label: 'Schad- und Störstofferkundung / Rückbaukonzept relevant?',
      type: 'yes_no_open',
      why: 'Beim Abbruch sind Schadstoffe und Verwertung gesondert zu betrachten.',
      conditions: [{ param: 'A5', op: 'includes_any', value: ['demolition'] }],
      writesTo: '/facts/demolition_concept/value',
    },
  ],
}
