/** Stage E, Technik & Energie: building services and energy. */

import type { ProjectIntakeStage } from '../intake-types'

export const TECHNOLOGY_STAGE: ProjectIntakeStage = {
  id: 'E',
  title: 'Technik & Energie',
  scope: 'building',
  repeatable: true,
  description: 'Wärmeversorgung, PV, Lüftung und anlagentechnischer Brandschutz je Bauwerk.',
  questions: [
    {
      id: 'E1',
      label: 'Geplante Wärmeversorgung',
      type: 'single_select',
      why: 'Relevant für Vorgaben zu erneuerbarer Wärme — bei fossilen Systemen im Neubau weist das System auf mögliche Konflikte hin.',
      options: [
        { value: 'heat_pump', label: 'Wärmepumpe' },
        { value: 'district_heating', label: 'Fernwärme' },
        { value: 'biomass', label: 'Biomasse' },
        { value: 'solar_hybrid', label: 'Solar-Hybrid' },
        { value: 'gas', label: 'Gas (nur Bestand)' },
        { value: 'open', label: 'noch offen' },
      ],
      writesTo: '/facts/heat_supply/value',
    },
    {
      // v1.0's E2 (PV) + E3 (Lüftung) + E4 (Kühlung) + E6 (Versickerung)
      // as one multi-select; the four boolean keys are bridged in
      // `answersFromProfile`.
      id: 'E2',
      label: 'Weitere Technik angedacht',
      type: 'multi_select',
      optional: true,
      why: 'Für einzelne Technikthemen gibt es je nach Standort eigene Vorgaben oder Fördermöglichkeiten.',
      options: [
        { value: 'pv', label: 'PV-Anlage' },
        { value: 'ventilation', label: 'mechanische Lüftung' },
        { value: 'cooling', label: 'aktive Kühlung' },
        { value: 'infiltration', label: 'Regenwasser-Versickerung' },
        { value: 'none', label: 'keine' },
        { value: 'open', label: 'noch offen' },
      ],
      writesTo: '/facts/further_technology/value',
    },
    {
      id: 'E3',
      label: 'Anlagentechnischer Brandschutz angedacht',
      type: 'multi_select',
      optional: true,
      why: 'Solche Anlagen sind oft Teil des Brandschutzkonzepts und bringen eigene technische Richtlinien mit.',
      options: [
        { value: 'fire_alarm', label: 'Brandmeldeanlage' },
        { value: 'sprinkler', label: 'Sprinkler' },
        { value: 'smoke_extraction', label: 'RWA' },
        { value: 'pressurisation', label: 'Druckbelüftung' },
        { value: 'none', label: 'keine' },
        { value: 'open', label: 'noch offen' },
      ],
      writesTo: '/facts/fire_safety_systems/value',
    },
    {
      id: 'E4',
      label: 'Aufzug geplant?',
      type: 'yes_no_open',
      hint: 'Die Aufzugspflicht wird später aus Geschoßanzahl und Landesrecht abgeleitet und gegen diese Angabe geprüft.',
      conditions: [{ param: 'C1', op: 'equals', value: 'building' }],
      writesTo: '/facts/elevator/value',
    },
    {
      id: 'E5',
      label: 'Feuerstätten / Rauchfänge geplant?',
      type: 'yes_no_open',
      conditions: [{ param: 'C1', op: 'equals', value: 'building' }],
      writesTo: '/facts/fireplaces/value',
    },
  ],
}
