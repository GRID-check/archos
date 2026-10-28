/** Stage D, Nutzungen: the use zones of each building. */

import { FOUND_IN, USES } from '../intake-options'
import type { ProjectIntakeStage } from '../intake-types'

export const USES_STAGE: ProjectIntakeStage = {
  id: 'D',
  title: 'Nutzungen',
  scope: 'building',
  repeatable: true,
  description:
    'Nutzungsmix je Bauwerk. Jede gewählte Nutzung erzeugt eine Zone mit generischen und nutzungsspezifischen Kennzahlen.',
  questions: [
    {
      id: 'D0',
      core: true,
      label: 'Welche Nutzungen enthält dieses Bauwerk (Zielzustand)?',
      type: 'multi_select',
      why: 'Jede Nutzung bringt eigene Themen und Regelwerke mit — vom Brandschutz bis zu speziellen Genehmigungen.',
      hint: 'Mehrfachauswahl — je Nutzung folgen Kennzahlen.',
      options: USES,
      writesTo: '/facts/uses/value',
      foundIn: [FOUND_IN.buildingDescription, FOUND_IN.floorLayout, FOUND_IN.permit],
      feeds: 'building_class',
    },
    {
      id: 'DX1',
      core: true,
      label: 'Ist das Bauwerk (teilweise) öffentlich zugänglich / mit Publikumsverkehr?',
      type: 'yes_no_open',
      why: 'Öffentlich zugängliche Bereiche bringen typischerweise Barrierefreiheitsanforderungen mit sich.',
      writesTo: '/facts/public_access/value',
      foundIn: [FOUND_IN.buildingDescription, FOUND_IN.permit],
    },
    {
      id: 'DX2',
      label: 'Ist das Bauwerk (teilweise) Arbeitsstätte?',
      type: 'yes_no_open',
      why: 'Für Arbeitsstätten gelten zusätzlich Vorschriften des Arbeitnehmerschutzes.',
      hint: 'Aus den Nutzungen vorbelegt (z. B. Büro, Handel, Produktion) — hier bestätigen.',
      writesTo: '/facts/workplace/value',
    },
  ],
  zoneCommon: [
    {
      id: 'D_fl',
      label: 'Fläche der Zone (BGF)',
      type: 'number_tri',
      unit: 'm²',
      writesTo: '/facts/zone_area/value',
    },
    {
      id: 'D_lage',
      label: 'Geschoßlage',
      type: 'single_select',
      options: [
        { value: 'above_ground', label: 'oberirdisch' },
        { value: 'below_ground', label: 'unterirdisch' },
        { value: 'both', label: 'beides' },
      ],
      writesTo: '/facts/zone_position/value',
    },
  ],
  zoneDefinitions: {
    residential: {
      questions: [
        {
          id: 'D_we',
          label: 'Anzahl Wohneinheiten',
          type: 'number_tri',
          writesTo: '/facts/dwelling_units/value',
        },
        {
          id: 'D_wohnform',
          label: 'Wohnform',
          type: 'single_select',
          options: [
            { value: 'conventional', label: 'klassisch' },
            { value: 'assisted', label: 'betreutes Wohnen' },
            { value: 'care_home', label: 'Heim' },
            { value: 'student', label: 'Studierendenheim' },
          ],
          writesTo: '/facts/residential_form/value',
        },
      ],
    },
    office: {
      questions: [
        {
          id: 'D_an',
          label: 'Max. gleichzeitig anwesende Arbeitnehmer:innen',
          type: 'number_tri',
          writesTo: '/facts/employees/value',
        },
      ],
    },
    retail: {
      questions: [
        {
          id: 'D_vkf',
          label: 'Verkaufsfläche',
          type: 'number_tri',
          unit: 'm²',
          writesTo: '/facts/sales_area/value',
        },
        {
          id: 'D_ekz',
          label: 'Teil eines Einkaufszentrums?',
          type: 'yes_no_open',
          writesTo: '/facts/shopping_centre/value',
        },
      ],
    },
    catering: {
      questions: [
        {
          id: 'D_plaetze',
          label: 'Max. Verabreichungsplätze / Personen',
          type: 'number_tri',
          writesTo: '/facts/serving_places/value',
        },
      ],
    },
    lodging: {
      questions: [
        {
          id: 'D_betten',
          label: 'Anzahl Gästebetten',
          type: 'number_tri',
          writesTo: '/facts/guest_beds/value',
        },
      ],
    },
    assembly: {
      questions: [
        {
          id: 'D_pers',
          label: 'Max. gleichzeitig anwesende Personen',
          type: 'number_tri',
          writesTo: '/facts/persons_max/value',
        },
      ],
    },
    education: {
      questions: [
        {
          id: 'D_bildung',
          label: 'Einrichtungstyp',
          type: 'single_select',
          options: [
            { value: 'kindergarten', label: 'Kindergarten' },
            { value: 'school', label: 'Schule' },
            { value: 'university', label: 'Hochschule' },
            { value: 'after_school_care', label: 'Hort' },
          ],
          writesTo: '/facts/education_type/value',
        },
        {
          id: 'D_kinder',
          label: 'Anzahl Kinder / Schüler:innen',
          type: 'number_tri',
          writesTo: '/facts/children_count/value',
        },
      ],
    },
    healthcare: {
      questions: [
        {
          id: 'D_gesund',
          label: 'Einrichtungstyp',
          type: 'single_select',
          options: [
            { value: 'practice', label: 'Ordination' },
            { value: 'hospital', label: 'Krankenhaus' },
            { value: 'nursing_home', label: 'Pflegeheim' },
          ],
          writesTo: '/facts/healthcare_type/value',
        },
      ],
    },
    production: {
      questions: [
        {
          id: 'D_gefstoffe',
          label: 'Lagerung / Verwendung gefährlicher Stoffe?',
          type: 'yes_no_open',
          writesTo: '/facts/hazardous_substances/value',
        },
        {
          id: 'D_brandlast',
          label: 'Brandlastintensive Nutzung?',
          type: 'yes_no_open',
          writesTo: '/facts/fire_load/value',
        },
      ],
    },
    garage: {
      questions: [
        {
          id: 'D_stp',
          label: 'Anzahl Pkw-Stellplätze',
          type: 'number_tri',
          writesTo: '/facts/parking_spaces/value',
        },
        {
          id: 'D_garagenlage',
          label: 'Lage',
          type: 'single_select',
          options: [
            { value: 'underground', label: 'Tiefgarage' },
            { value: 'above_ground_enclosed', label: 'oberirdisch geschlossen' },
            { value: 'covered_open', label: 'überdacht offen' },
            { value: 'open_air', label: 'Freistellplätze' },
          ],
          writesTo: '/facts/garage_position/value',
        },
        {
          id: 'D_garagenfl',
          label: 'Nutzfläche der Garage',
          type: 'number_tri',
          unit: 'm²',
          writesTo: '/facts/garage_area/value',
        },
        {
          id: 'D_lade',
          label: 'E-Ladepunkte geplant?',
          type: 'yes_no_open',
          writesTo: '/facts/ev_charge_points/value',
        },
      ],
    },
    agriculture: {
      questions: [
        {
          id: 'D_tiere',
          label: 'Tierhaltung?',
          type: 'yes_no_open',
          writesTo: '/facts/livestock/value',
        },
      ],
    },
    technical: {
      questions: [
        {
          id: 'D_technik',
          label: 'Kurzbeschreibung',
          type: 'text',
          placeholder: 'z. B. Trafostation, Haustechnikzentrale',
          writesTo: '/facts/technical_description/value',
        },
      ],
    },
  },
}
