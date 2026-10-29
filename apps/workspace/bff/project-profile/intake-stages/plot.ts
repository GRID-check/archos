/** Stage B, Grundstück & Widmung: the plot and its zoning. */

import { FOUND_IN } from '../intake-options'
import type { ProjectIntakeStage } from '../intake-types'
import { PRODUCT_NAME } from '@/lib/brand'

export const PLOT_STAGE: ProjectIntakeStage = {
  id: 'B',
  title: 'Grundstück & Widmung',
  scope: 'plot',
  description:
    'Widmung, Bebauungsplan-Kernset, Standortrisiken und Erschließung. Jede Kennzahl einzeln offen lassbar.',
  questions: [
    // The Grundbuch's name for the plot and its area: what the location
    // register asks the Grundbuchauszug for (ticket 26, „Standort-
    // informationen aus den Unterlagen", `lib/project-intake/location-register.ts`).
    {
      id: 'B0_ez',
      label: 'Einlagezahl und Katastralgemeinde',
      type: 'text',
      optional: true,
      placeholder: 'z. B. EZ 1234, KG 01503 Hernals',
      why: 'Bezeichnet das Grundstück eindeutig. Damit lassen sich Grundbuch, Widmung und Gefahrenzonen für genau dieses Grundstück nachschlagen.',
      writesTo: '/facts/plot_register_number/value',
      foundIn: [FOUND_IN.landRegister, FOUND_IN.siteLayout, FOUND_IN.permit],
    },
    {
      id: 'B0_flaeche',
      label: 'Grundstücksfläche',
      type: 'number_tri',
      unit: 'm²',
      optional: true,
      why: 'Bezugsgröße für Bebauungsdichte und bebaubare Fläche.',
      writesTo: '/facts/plot_area/value',
      foundIn: [FOUND_IN.landRegister, FOUND_IN.siteLayout, FOUND_IN.buildingDescription],
    },
    {
      id: 'B1',
      core: true,
      label: 'Flächenwidmung (Kategorie)',
      type: 'single_select',
      optional: true,
      why: 'Hilft einzuschätzen, ob die geplante Nutzung an diesem Standort grundsätzlich möglich ist.',
      options: [
        { value: 'residential', label: 'Wohngebiet' },
        { value: 'mixed', label: 'gemischtes Baugebiet' },
        { value: 'core', label: 'Kerngebiet' },
        { value: 'commercial', label: 'Betriebs-/Industriegebiet' },
        { value: 'special', label: 'Sondergebiet' },
        { value: 'green_special', label: 'Grünland mit Sonderwidmung' },
        { value: 'other', label: 'sonstige' },
        { value: 'open', label: 'noch offen' },
      ],
      writesTo: '/facts/zoning/value',
      foundIn: [FOUND_IN.zoning, FOUND_IN.developmentPlan, FOUND_IN.permit],
    },
    {
      // v1.0's B1_orig, now unconditionally visible: the original wording
      // OR the user's own words both land here.
      id: 'B1_text',
      core: true,
      label: 'Widmung im Originalwortlaut oder eigenen Worten',
      type: 'text',
      optional: true,
      placeholder: 'z. B. W II g 12m – oder frei beschreiben',
      writesTo: '/facts/zoning_original/value',
      foundIn: [
        FOUND_IN.zoning,
        FOUND_IN.developmentPlan,
        FOUND_IN.permit,
        FOUND_IN.buildingDescription,
      ],
    },
    {
      id: 'B2',
      core: true,
      label: 'Liegt ein Bebauungsplan vor?',
      type: 'yes_no_open',
      writesTo: '/facts/development_plan/value',
      foundIn: [FOUND_IN.developmentPlan, FOUND_IN.permit, FOUND_IN.buildingDescription],
    },
    {
      // Spec: unconditional `upload` for B-Plan OR FWP. Ours binds the
      // `development_plan` role, so it stays behind B2 = ja; the
      // Flächenwidmungsplan has its own Modul I slot. Same document space
      // either way (ADR: document_roles), so "dort abgelegte Dokumente hier
      // als erledigt anzeigen" holds by construction.
      id: 'B2_upl',
      core: true,
      label: 'Bebauungsplan ablegen',
      type: 'document_role',
      role: 'development_plan',
      conditions: [{ param: 'B2', op: 'equals', value: 'yes' }],
      why: 'Der Plan ist die Quelle für Bauklasse, Bebauungsweise, Dichte und Fluchtlinien — ' + PRODUCT_NAME + ' kann sich dann darauf beziehen.',
    },
    {
      id: 'B3_hoehe',
      label: 'Bauklasse oder zulässige Gebäudehöhe',
      type: 'number_tri',
      unit: 'm',
      kernset: true,
      why: 'Höhenvorgaben der Landes-Bauordnung; Grundlage der Zulässigkeitsprüfung des Entwurfs.',
      conditions: [{ param: 'B2', op: 'equals', value: 'yes' }],
      writesTo: '/facts/max_building_height/value',
      foundIn: [FOUND_IN.developmentPlan, FOUND_IN.permit],
    },
    {
      id: 'B3_weise',
      label: 'Bebauungsweise',
      type: 'single_select',
      kernset: true,
      conditions: [{ param: 'B2', op: 'equals', value: 'yes' }],
      options: [
        { value: 'open', label: 'offen' },
        { value: 'semi_detached', label: 'gekuppelt' },
        { value: 'closed', label: 'geschlossen' },
        { value: 'undecided', label: 'noch offen' },
      ],
      writesTo: '/facts/development_pattern/value',
      foundIn: [FOUND_IN.developmentPlan, FOUND_IN.permit],
    },
    {
      id: 'B3_dichte',
      label: 'Bebauungsdichte (GFZ, GRZ oder bebaubare Fläche)',
      type: 'number_tri',
      kernset: true,
      placeholder: 'z. B. 1.5',
      conditions: [{ param: 'B2', op: 'equals', value: 'yes' }],
      writesTo: '/facts/development_density/value',
      foundIn: [FOUND_IN.developmentPlan, FOUND_IN.permit],
    },
    {
      id: 'B3_flucht',
      label: 'Baufluchtlinien oder Baugrenzen einschränkend?',
      type: 'yes_no_open',
      kernset: true,
      conditions: [{ param: 'B2', op: 'equals', value: 'yes' }],
      writesTo: '/facts/building_lines/value',
      foundIn: [FOUND_IN.developmentPlan, FOUND_IN.siteLayout, FOUND_IN.permit],
    },
    {
      // Absorbs v1.0's A8 (Schutzzone / Altstadterhaltung) — part of the
      // B-Plan-Kernset now.
      id: 'B3_bes',
      label: 'Besondere Bestimmungen inkl. Schutzzone',
      type: 'text',
      kernset: true,
      optional: true,
      placeholder: 'z. B. Schutzzone, Dachvorschriften, Begrünungspflicht',
      conditions: [{ param: 'B2', op: 'equals', value: 'yes' }],
      writesTo: '/facts/development_plan_notes/value',
      foundIn: [FOUND_IN.developmentPlan, FOUND_IN.permit],
    },
    {
      id: 'B3_stellplatz',
      label: 'Stellplatzregulativ (falls vorhanden)',
      type: 'text',
      kernset: true,
      optional: true,
      placeholder: 'z. B. 1 Stellplatz je Wohnung',
      conditions: [{ param: 'B2', op: 'equals', value: 'yes' }],
      writesTo: '/facts/parking_regulation/value',
      foundIn: [FOUND_IN.developmentPlan, FOUND_IN.permit],
    },
    {
      // v1.0's B4 + B5 (Altlast) + B9 (Baumbestand) + B10 (Schutzgebiet)
      // as ONE multi-select. The storage key stays `hazard_zones`: the old
      // values are a strict subset of the new vocabulary, so every stored
      // answer remains valid, and a key rename would strand them.
      id: 'B4',
      label: 'Standortrisiken & Schutzgüter',
      type: 'multi_select',
      optional: true,
      why: 'Solche Punkte können Einschränkungen oder zusätzliche Verfahren mit sich bringen — der Assistent behält sie im Blick.',
      options: [
        { value: 'flood_hq30', label: 'Hochwasser HQ30' },
        { value: 'flood_hq100', label: 'Hochwasser HQ100' },
        { value: 'torrent_yellow', label: 'Wildbach/Lawine – gelbe Zone' },
        { value: 'torrent_red', label: 'Wildbach/Lawine – rote Zone' },
        { value: 'landslide', label: 'Rutschung / Steinschlag' },
        { value: 'contaminated_land', label: 'Altlast / Verdachtsfläche' },
        { value: 'tree_stock', label: 'geschützter Baumbestand' },
        { value: 'protected_area', label: 'Natur- oder Landschaftsschutzgebiet' },
        { value: 'none', label: 'keine' },
        { value: 'open', label: 'noch offen' },
      ],
      writesTo: '/facts/hazard_zones/value',
      foundIn: [FOUND_IN.hazardZonePlan, FOUND_IN.zoning, FOUND_IN.contaminatedSites, FOUND_IN.permit],
    },
    {
      id: 'B5',
      label: 'Lärmsituation am Standort',
      type: 'single_select',
      optional: true,
      why: 'Die Lärmsituation beeinflusst typischerweise die Anforderungen an Fenster und Außenbauteile — exakte Pegel kommen später mit dem Gutachten.',
      options: [
        { value: 'quiet', label: 'ruhig' },
        { value: 'urban', label: 'innerstädtisch üblich' },
        { value: 'road', label: 'stark befahrene Straße' },
        { value: 'rail', label: 'Bahn' },
        { value: 'air', label: 'Fluglärm' },
        { value: 'commercial', label: 'Gewerbelärm' },
        { value: 'open', label: 'noch offen' },
      ],
      writesTo: '/facts/noise_situation/value',
      foundIn: [FOUND_IN.noise, FOUND_IN.buildingDescription],
    },
    {
      id: 'B6',
      label: 'Ist das Grundstück voll erschlossen (Kanal, Wasser, Strom, Zufahrt)?',
      type: 'single_select',
      why: 'Zeigt, ob Erschließungsthemen wie Anschlüsse oder Zufahrt im Projekt mitzudenken sind.',
      options: [
        { value: 'yes', label: 'ja' },
        { value: 'partial', label: 'teilweise' },
        { value: 'no', label: 'nein' },
        { value: 'open', label: 'noch offen' },
      ],
      writesTo: '/facts/servicing/value',
    },
    {
      id: 'B7',
      label: 'Fernwärme',
      type: 'single_select',
      why: 'In manchen Gebieten gibt es Anschlussvorgaben — außerdem relevant für die Wahl der Wärmeversorgung.',
      options: [
        { value: 'available', label: 'verfügbar' },
        { value: 'connection_area', label: 'Anschlussgebiet (Anschlusspflicht möglich)' },
        { value: 'unavailable', label: 'nicht verfügbar' },
        { value: 'open', label: 'noch offen' },
      ],
      writesTo: '/facts/district_heating_status/value',
    },
    {
      id: 'B8',
      label: 'Anbau an Nachbargebäude oder Bebauung nahe der Grundgrenze geplant?',
      type: 'yes_no_open',
      why: 'Bei Bebauung nahe der Grundgrenze spielen Abstände und Brandschutz zwischen Gebäuden eine größere Rolle.',
      writesTo: '/facts/build_to_plot_boundary/value',
    },
  ],
}
