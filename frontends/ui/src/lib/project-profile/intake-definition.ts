import { normalizeProfilePatchOperation } from './legacy-names'
import { applyProjectProfilePatch, emptyProjectProfile } from './patch-engine'
// Type-only, and deliberately so: `document-roles` imports the condition
// evaluator from this module as a VALUE. A type import is erased at compile
// time, so the two files reference each other without a runtime cycle.
import type { DocumentRole } from './document-roles'
import type {
  ProjectAssumption,
  ProjectFact,
  ProjectPrimitiveValue,
  ProjectProfile,
  ProjectProfilePatchOperation,
} from './types'

// ---------------------------------------------------------------------------
// Project-Wizard Baurecht Österreich — machine-readable content specification.
//
// Faithful implementation of `wizard_spec.json` / `wizard_konzept.md`: modules
// A–H, the stable question IDs (A5, C4, D_garagenfl …) that are the reference
// anchors of the later classification logic, the four scopes
// (projekt → grundstück → building 1..n → nutzungszone 1..n per building), and the
// three answer modes.
//
// Answer modes map onto the profile's existing three-state model rather than a
// new schema field, so the mode already reaches the AI agent through the
// prompt-view (confirmed: / assumptions: / unknown: sections):
//   • number_tri mode 'wert'       → confirmed fact
//   • number_tri mode 'geschaetzt' → unconfirmed assumption (estimated)
//   • number_tri mode 'offen'      → unknown
//   • yes_no_open 'ja' / 'nein'    → boolean fact
//   • yes_no_open 'offen'          → unknown
//
// The stable question `id` is the classification anchor; `writesTo` bridges it to
// a descriptive storage key so the jurisdiction pipeline (facts.federal_state) and
// the LLM-consumed prompt view stay readable. Two bridges are load-bearing and
// MUST NOT change key: A1 → project_name, A2_land → federal_state.
// ---------------------------------------------------------------------------

export type ProjectIntakeQuestionType =
  | 'single_select'
  | 'multi_select'
  | 'boolean'
  | 'number'
  | 'text'
  | 'textarea'
  | 'number_tri'
  | 'yes_no_open'
  | 'upload'
  | 'document_role'
  | 'info_placeholder'

/** The three answer-modes a number_tri question persists. */
export type IntakeAnswerMode = 'wert' | 'geschaetzt' | 'offen'

/** The three-valued yes_no_open answer. */
export type YesNoOpen = 'ja' | 'nein' | 'offen'

export type ProjectIntakeScope = 'projekt' | 'grundstueck' | 'bauwerk'

export interface ProjectIntakeOption {
  value: string
  label: string
}

/**
 * A single display condition. Multiple conditions on one question are
 * AND-combined. `param` references another question's id; it is resolved within
 * the same scope instance (a building question's condition on `C1` reads *this*
 * bauwerk's C1), falling back to the project-global answer for project-scope
 * params such as `A5`.
 */
export interface ProjectIntakeCondition {
  param: string
  /**
   * `lte` is numeric and only satisfied when a value exists AND its answer mode is not 'offen'.
   * `excludes_any` holds when the answer holds none of the values, so an unanswered param holds it.
   */
  op: 'equals' | 'includes_any' | 'excludes_any' | 'not_empty' | 'lte'
  value?: string | string[] | number
}

export interface ProjectIntakeQuestion {
  id: string
  label: string
  type: ProjectIntakeQuestionType
  /** Short helper under the label. */
  help?: string
  /** One-sentence legal rationale, shown behind a "Warum fragen wir das?" toggle. */
  why?: string
  /** Extra guidance / definition hint. */
  hint?: string
  /** Unit suffix for numeric questions (m, m², dB …). */
  unit?: string
  /**
   * For `document_role`: which slot this question fills. The binding is stored
   * in `document_roles`, not in the answer map — a document is not an answer,
   * and putting a file id in the profile would make the profile the second
   * place a binding lives.
   */
  role?: DocumentRole
  /**
   * Sub-heading this question opens within its module.
   *
   * Modul C interleaves two descriptions of the same building — what stands
   * there today (CB*) and what will stand there after the work (C3–C11) — and
   * the Zielzustand principle is the concept's whole basis for deriving the
   * building class. Running them together as one list of twenty-two fields makes
   * "Bestand heute: oberirdische Geschoße" and "Anzahl oberirdischer Geschoße
   * (Zielzustand)" look like the same question asked twice.
   */
  group?: string
  /**
   * Kernfrage: shown in Schnellstart mode; every non-core question the
   * Schnellstart skips is persisted with mode 'offen' so the completion
   * checklist in Modul H can list it.
   */
  core?: boolean
  /**
   * Part of the Bebauungsplan extraction core set (concept Kap. 4-B): the
   * values the phase-2 vision extraction targets and the review screen
   * confirms. Descriptive until that flow lands.
   */
  kernset?: boolean
  placeholder?: string
  options?: ProjectIntakeOption[]
  /** AND-combined display conditions. */
  conditions?: ProjectIntakeCondition[]
  writesTo?: string
  /**
   * Hard-required: the wizard blocks advancing until this is answered. Per the
   * konzept only A1/A2/A5 are required; everything else is deliberately soft so
   * the wizard never blocks (an empty answer degrades to an unknown).
   */
  required?: boolean
  /**
   * Skippable: shown with an "optional" hint. Purely cosmetic — non-required
   * questions are already non-blocking; this just labels the ones worth flagging.
   */
  optional?: boolean
  /**
   * For `info_placeholder`: the id of the system derivation that will appear
   * here in phase 2 (e.g. `building_class`, `uvp`). Purely descriptive.
   */
  derives?: string
  /**
   * The documents (German kinds, as an Austrian office names them) where the
   * value is usually stated: „Einreichplan (Schnitt)", „Baubeschreibung". The
   * intake agent reads them first and a Rückfrage names them. Descriptive:
   * nothing validates a document against it.
   */
  foundIn?: string[]
  /**
   * The derivation this value is an input of. Descriptive here; `lib/project-intake`
   * reads it to know which gaps could change the building class.
   */
  feeds?: 'building_class'
}

/** A per-use zone question set (module D `zone_definitions`). */
export interface ProjectIntakeZoneDefinition {
  questions: ProjectIntakeQuestion[]
}

export interface ProjectIntakeStage {
  id: string
  title: string
  description?: string
  scope: ProjectIntakeScope
  /** `bauwerk` modules render once per building. */
  repeatable?: boolean
  questions: ProjectIntakeQuestion[]
  /** Module D: questions asked for every selected use-zone. */
  zoneCommon?: ProjectIntakeQuestion[]
  /** Module D: use-specific follow-up questions, keyed by the D0 option value. */
  zoneDefinitions?: Record<string, ProjectIntakeZoneDefinition>
}

export interface ProjectIntakeDefinition {
  version: number
  stages: ProjectIntakeStage[]
}

/** The use-catalog (D0), reused for both the multi-select and the zone expansion. */
const USES: ProjectIntakeOption[] = [
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
const FOUND_IN = {
  titleBlock: 'Einreichplan (Plankopf)',
  sitePlan: 'Lageplan',
  submissionSitePlan: 'Einreichplan (Lageplan)',
  floorPlan: 'Einreichplan (Grundriss)',
  section: 'Einreichplan (Schnitt)',
  elevation: 'Einreichplan (Ansicht)',
  buildingDescription: 'Baubeschreibung',
  permitDecision: 'Bescheid',
  landRegister: 'Grundbuchauszug',
  zoning: 'Flächenwidmungsplan',
  developmentPlan: 'Bebauungsplan (Plandokument)',
  energyCertificate: 'Energieausweis',
  fireSafety: 'Brandschutzkonzept',
  structural: 'Statik',
} as const

export const projectIntakeDefinitionV1: ProjectIntakeDefinition = {
  version: 5,
  stages: [
    // ------------------------------------------------------------------ A
    {
      id: 'A',
      title: 'Projektbasis',
      scope: 'projekt',
      description: 'Stammdaten, Standort und Art des Vorhabens.',
      questions: [
        {
          id: 'A1',
          core: true,
          label: 'Projektname',
          type: 'text',
          required: true,
          placeholder: 'z. B. WHA Quellenstraße',
          writesTo: '/facts/project_name/value',
          foundIn: [FOUND_IN.titleBlock, FOUND_IN.buildingDescription, FOUND_IN.permitDecision],
        },
        {
          id: 'A2_adr',
          core: true,
          label: 'Adresse / Gemeinde',
          type: 'text',
          required: true,
          placeholder: 'Straße, PLZ Ort',
          why: 'Aus der Gemeinde folgen örtliche Vorschriften wie Fernwärme-Anschlussgebiete oder Schutzzonen.',
          writesTo: '/facts/site_address/value',
          foundIn: [FOUND_IN.titleBlock, FOUND_IN.submissionSitePlan, FOUND_IN.landRegister, FOUND_IN.permitDecision],
        },
        // Spec id A2_staat with AT/DE only. Kept as the shipped superset: the
        // storage key `country` and its token set are load-bearing (mirrored by
        // the backend jurisdiction pipeline), and CH/other already exist in
        // stored projects. The German federal state list rides with the German
        // question catalog (v2, per README Länder-Scope) — until then non-AT
        // locations describe themselves in `site_details`.
        {
          id: 'A2_country',
          core: true,
          label: 'Land',
          type: 'single_select',
          required: true,
          help: 'In welchem Land befindet sich das Bauvorhaben?',
          why: 'Über den Standort stellt das System zusammen, welche Rechtstexte und Richtlinien für dieses Projekt gelten. Für Deutschland werden Fragebogen und Regelwerks-Layer noch angepasst.',
          options: [
            { value: 'at', label: 'Österreich (AT)' },
            { value: 'de', label: 'Deutschland (DE)' },
            { value: 'ch', label: 'Schweiz (CH)' },
            { value: 'other', label: 'Anderes Land' },
          ],
          writesTo: '/facts/country/value',
          foundIn: [FOUND_IN.titleBlock, FOUND_IN.buildingDescription],
        },
        {
          id: 'A2_land',
          core: true,
          label: 'Bundesland',
          type: 'single_select',
          required: true,
          // Asked unless another country was chosen: Piloti is Austria's, and a
          // reading that finds „Bundesland: Wien“ before any document names the
          // country must still be asked for it. Answering it derives `country`.
          conditions: [{ param: 'A2_country', op: 'excludes_any', value: ['de', 'ch', 'other'] }],
          why: 'Bestimmt, welche landesspezifischen Rechtstexte für den Standort herangezogen werden.',
          options: [
            { value: 'vienna', label: 'Wien' },
            { value: 'lower_austria', label: 'Niederösterreich' },
            { value: 'upper_austria', label: 'Oberösterreich' },
            { value: 'styria', label: 'Steiermark' },
            { value: 'carinthia', label: 'Kärnten' },
            { value: 'salzburg', label: 'Salzburg' },
            { value: 'tyrol', label: 'Tirol' },
            { value: 'vorarlberg', label: 'Vorarlberg' },
            { value: 'burgenland', label: 'Burgenland' },
            { value: 'outside_austria', label: 'Außerhalb Österreichs' },
          ],
          writesTo: '/facts/federal_state/value',
          foundIn: [FOUND_IN.titleBlock, FOUND_IN.permitDecision, FOUND_IN.buildingDescription],
        },
        {
          id: 'site_details',
          label: 'Land & Region',
          help: 'Land und Region/Stadt, z. B. „Bayern, Deutschland" — für die Einordnung des anwendbaren Rechts.',
          type: 'text',
          conditions: [{ param: 'A2_country', op: 'includes_any', value: ['de', 'ch', 'other'] }],
          writesTo: '/facts/site_details/value',
        },
        {
          id: 'A4',
          core: true,
          label: 'Aktuelle Projektphase',
          type: 'single_select',
          why: 'Steuert die Erwartung an die Antwortgüte und das Phasen-Nudging: in frühen Phasen werden Schätzwerte aktiv angeboten, vor der Einreichung an offene Schätzungen erinnert.',
          options: [
            { value: 'basic_evaluation', label: 'Grundlagenermittlung' },
            { value: 'preliminary_design', label: 'Vorentwurf' },
            { value: 'design', label: 'Entwurf' },
            { value: 'submission_planning', label: 'Einreichplanung' },
            { value: 'execution_planning', label: 'Ausführungsplanung' },
            { value: 'tendering', label: 'Ausschreibung & Vergabe' },
            { value: 'construction', label: 'Ausführung' },
            { value: 'completion_handover', label: 'Fertigstellung & Übergabe' },
            { value: 'existing_operation', label: 'Bestand & Betrieb' },
          ],
          writesTo: '/facts/project_phase/value',
          foundIn: [FOUND_IN.titleBlock, FOUND_IN.buildingDescription, FOUND_IN.permitDecision],
        },
        {
          id: 'A5',
          core: true,
          label: 'Art des Vorhabens (Projekt gesamt)',
          type: 'multi_select',
          required: true,
          why: 'Steuert, welche Fragen und Themen für dieses Projekt überhaupt relevant sind.',
          options: [
            { value: 'new_build', label: 'Neubau' },
            { value: 'extension', label: 'Zubau' },
            { value: 'conversion', label: 'Umbau' },
            { value: 'refurbishment', label: 'Sanierung' },
            { value: 'change_of_use', label: 'Nutzungsänderung' },
            { value: 'demolition', label: 'Abbruch' },
            { value: 'external_works', label: 'Außenanlagen' },
          ],
          writesTo: '/facts/work_type/value',
          foundIn: [FOUND_IN.buildingDescription, FOUND_IN.permitDecision, FOUND_IN.titleBlock],
        },
      ],
    },
    // ------------------------------------------------------------------ B
    {
      id: 'B',
      title: 'Grundstück & Widmung',
      scope: 'grundstueck',
      description:
        'Widmung, Bebauungsplan-Kernset, Standortrisiken und Erschließung. Jede Kennzahl einzeln offen lassbar.',
      questions: [
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
          foundIn: [FOUND_IN.zoning, FOUND_IN.developmentPlan, FOUND_IN.permitDecision],
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
            FOUND_IN.permitDecision,
            FOUND_IN.buildingDescription,
          ],
        },
        {
          id: 'B2',
          core: true,
          label: 'Liegt ein Bebauungsplan vor?',
          type: 'yes_no_open',
          writesTo: '/facts/development_plan/value',
          foundIn: [FOUND_IN.developmentPlan, FOUND_IN.permitDecision, FOUND_IN.buildingDescription],
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
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          why: 'Der Plan ist die Quelle für Bauklasse, Bebauungsweise, Dichte und Fluchtlinien — Piloti kann sich dann darauf beziehen.',
        },
        {
          id: 'B3_hoehe',
          label: 'Bauklasse oder zulässige Gebäudehöhe',
          type: 'number_tri',
          unit: 'm',
          kernset: true,
          why: 'Höhenvorgaben der Landes-Bauordnung; Grundlage der Zulässigkeitsprüfung des Entwurfs.',
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/max_building_height/value',
          foundIn: [FOUND_IN.developmentPlan, FOUND_IN.permitDecision],
        },
        {
          id: 'B3_weise',
          label: 'Bebauungsweise',
          type: 'single_select',
          kernset: true,
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          options: [
            { value: 'open', label: 'offen' },
            { value: 'semi_detached', label: 'gekuppelt' },
            { value: 'closed', label: 'geschlossen' },
            { value: 'undecided', label: 'noch offen' },
          ],
          writesTo: '/facts/development_pattern/value',
          foundIn: [FOUND_IN.developmentPlan, FOUND_IN.permitDecision],
        },
        {
          id: 'B3_dichte',
          label: 'Bebauungsdichte (GFZ, GRZ oder bebaubare Fläche)',
          type: 'number_tri',
          kernset: true,
          placeholder: 'z. B. 1.5',
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/development_density/value',
          foundIn: [FOUND_IN.developmentPlan, FOUND_IN.permitDecision],
        },
        {
          id: 'B3_flucht',
          label: 'Baufluchtlinien oder Baugrenzen einschränkend?',
          type: 'yes_no_open',
          kernset: true,
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/building_lines/value',
          foundIn: [FOUND_IN.developmentPlan, FOUND_IN.sitePlan, FOUND_IN.permitDecision],
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
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/development_plan_notes/value',
          foundIn: [FOUND_IN.developmentPlan, FOUND_IN.permitDecision],
        },
        {
          id: 'B3_stellplatz',
          label: 'Stellplatzregulativ (falls vorhanden)',
          type: 'text',
          kernset: true,
          optional: true,
          placeholder: 'z. B. 1 Stellplatz je Wohnung',
          conditions: [{ param: 'B2', op: 'equals', value: 'ja' }],
          writesTo: '/facts/parking_regulation/value',
          foundIn: [FOUND_IN.developmentPlan, FOUND_IN.permitDecision],
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
    },
    // ------------------------------------------------------------------ C
    //
    // Spec C0 (Bauwerksliste) is realized by the wizard's building-management
    // UI (duplizierbare Karten, min. 1 building) rather than a question row —
    // rendering it additionally as a question would describe controls sitting
    // directly above it.
    {
      id: 'C',
      title: 'Bauwerke',
      scope: 'bauwerk',
      repeatable: true,
      description:
        'Je Bauwerk: Neubau oder Bestand, ggf. Bestandsblock, dann Zielgeometrie. Die Zielgeometrie beschreibt immer den Zustand nach Umsetzung aller Maßnahmen; daraus wird die Gebäudeklasse abgeleitet.',
      questions: [
        {
          id: 'C1',
          core: true,
          label: 'Bauwerkstyp',
          type: 'single_select',
          why: 'Für sehr kleine und sonstige Bauwerke gelten deutlich reduzierte Anforderungen.',
          options: [
            { value: 'building', label: 'Gebäude' },
            { value: 'small', label: 'Kleinstgebäude (bis 15 m²)' },
            { value: 'other', label: 'sonstiges Bauwerk (Flugdach, Stützmauer, Werbeanlage …)' },
          ],
          writesTo: '/facts/building_type/value',
          foundIn: [FOUND_IN.buildingDescription, FOUND_IN.elevation, FOUND_IN.permitDecision],
          feeds: 'building_class',
        },
        {
          id: 'C2',
          core: true,
          label: 'Neubau oder Bestand?',
          type: 'single_select',
          why: 'Für Bestandsgebäude gibt es einen eigenen Fragenblock, weil dort teils andere Regeln gelten.',
          options: [
            { value: 'new_build', label: 'Neubau' },
            { value: 'existing', label: 'Bestandsgebäude' },
          ],
          writesTo: '/facts/construction_status/value',
          foundIn: [FOUND_IN.buildingDescription, FOUND_IN.permitDecision, FOUND_IN.floorPlan],
        },
        // -------------------------------------------------- Bestandsblock
        // v1.0 asked these once per PROJECT (A6/A7/A9/A10); since v1.1 they
        // belong to the building whose Bestand they describe. The storage keys
        // are unchanged — only the scope suffix is new — and
        // `answersFromProfile` bridges legacy project-scope values into the
        // single-building case.
        {
          id: 'CB1',
          group: 'Bestand heute',
          label: 'Baujahr des Bestands (ca.)',
          type: 'number_tri',
          placeholder: 'z. B. 1962',
          why: 'Das Alter hilft einzuordnen, welche Regeln damals galten und was heute Bestandsschutz genießt.',
          conditions: [{ param: 'C2', op: 'equals', value: 'existing' }],
          writesTo: '/facts/existing_year_built/value',
          foundIn: [FOUND_IN.energyCertificate, FOUND_IN.buildingDescription, FOUND_IN.permitDecision],
        },
        {
          id: 'CB2',
          label: 'Bisherige Nutzung',
          type: 'text',
          placeholder: 'z. B. Wohnhaus, Lagerhalle, Bürogebäude',
          why: 'Ändert sich die Nutzung, kann das zusätzliche Anforderungen auslösen.',
          conditions: [{ param: 'C2', op: 'equals', value: 'existing' }],
          writesTo: '/facts/existing_use/value',
        },
        {
          id: 'CB3',
          core: true,
          label: 'Steht das Gebäude unter Denkmalschutz?',
          type: 'yes_no_open',
          why: 'Denkmalschutz bringt ein eigenes Verfahren und teils Erleichterungen bei anderen Anforderungen mit sich.',
          conditions: [{ param: 'C2', op: 'equals', value: 'existing' }],
          writesTo: '/facts/heritage_protection/value',
          foundIn: [FOUND_IN.permitDecision, FOUND_IN.buildingDescription],
        },
        {
          id: 'CB4',
          core: true,
          label: 'Geplante Maßnahmen am Bestand',
          type: 'multi_select',
          why: 'Die Art der Maßnahmen bestimmt, welche Anforderungen am Bestand überhaupt greifen.',
          options: [
            { value: 'envelope_refurbishment', label: 'Sanierung der Gebäudehülle' },
            { value: 'interior_conversion', label: 'Umbau im Inneren' },
            { value: 'storey_addition', label: 'Aufstockung' },
            { value: 'extension', label: 'Zubau' },
            { value: 'change_of_use', label: 'Nutzungsänderung' },
            { value: 'core_refurbishment', label: 'Kernsanierung' },
            { value: 'partial_demolition', label: 'Teilabbruch' },
          ],
          conditions: [{ param: 'C2', op: 'equals', value: 'existing' }],
          writesTo: '/facts/existing_measures/value',
          foundIn: [FOUND_IN.buildingDescription, FOUND_IN.floorPlan, FOUND_IN.permitDecision],
        },
        {
          id: 'CB5',
          label: 'Eingriff in die Tragstruktur geplant?',
          type: 'yes_no_open',
          why: 'Eingriffe ins Tragwerk sind statisch und im Verfahren gesondert zu betrachten.',
          conditions: [{ param: 'C2', op: 'equals', value: 'existing' }],
          writesTo: '/facts/structural_intervention/value',
        },
        {
          id: 'CB6',
          label: 'Größere Renovierung (mehr als 25 % der Gebäudehülle betroffen)?',
          type: 'yes_no_open',
          why: 'Ab einem gewissen Sanierungsumfang gelten erhöhte energetische Anforderungen.',
          conditions: [
            { param: 'C2', op: 'equals', value: 'existing' },
            { param: 'CB4', op: 'includes_any', value: ['envelope_refurbishment', 'core_refurbishment'] },
          ],
          writesTo: '/facts/major_renovation/value',
        },
        {
          id: 'CB7_og',
          label: 'Bestand heute: oberirdische Geschoße',
          type: 'number_tri',
          why: 'Der Vergleich von Bestand und Ziel zeigt, welche Teile eher wie ein Neubau und welche im Bestandsschutz zu behandeln sind.',
          conditions: [{ param: 'C2', op: 'equals', value: 'existing' }],
          writesTo: '/facts/existing_storeys_above_ground/value',
        },
        {
          id: 'CB7_ug',
          label: 'Bestand heute: unterirdische Geschoße',
          type: 'number_tri',
          conditions: [{ param: 'C2', op: 'equals', value: 'existing' }],
          writesTo: '/facts/existing_storeys_below_ground/value',
        },
        {
          id: 'CB7_bgf',
          label: 'Bestand heute: BGF der oberirdischen Geschoße',
          type: 'number_tri',
          unit: 'm²',
          conditions: [{ param: 'C2', op: 'equals', value: 'existing' }],
          writesTo: '/facts/existing_gfa_above_ground/value',
        },
        {
          id: 'CB7_fn',
          label: 'Bestand heute: Fluchtniveau',
          type: 'number_tri',
          unit: 'm',
          conditions: [{ param: 'C2', op: 'equals', value: 'existing' }],
          writesTo: '/facts/existing_escape_level_m/value',
        },
        // -------------------------------------------------- Zielgeometrie
        {
          id: 'C3',
          group: 'Zielzustand — nach Umsetzung aller Maßnahmen',
          core: true,
          label: 'Anzahl oberirdischer Geschoße (Zielzustand)',
          type: 'number_tri',
          why: 'Einer der wichtigsten Werte für die Einstufung des Gebäudes — außerdem relevant für die Aufzugsfrage.',
          hint: 'Immer den Zustand NACH Umsetzung aller Maßnahmen angeben – bei Aufstockung von drei auf fünf Geschoße also fünf.',
          conditions: [{ param: 'C1', op: 'equals', value: 'building' }],
          writesTo: '/facts/storeys_above_ground/value',
          foundIn: [
            FOUND_IN.section,
            FOUND_IN.elevation,
            FOUND_IN.floorPlan,
            FOUND_IN.buildingDescription,
          ],
          feeds: 'building_class',
        },
        {
          id: 'C4',
          label: 'Anzahl unterirdischer Geschoße (Zielzustand)',
          type: 'number_tri',
          conditions: [{ param: 'C1', op: 'equals', value: 'building' }],
          writesTo: '/facts/storeys_below_ground/value',
          foundIn: [FOUND_IN.section, FOUND_IN.floorPlan, FOUND_IN.buildingDescription],
        },
        {
          id: 'C5',
          core: true,
          label: 'Fluchtniveau (Zielzustand)',
          type: 'number_tri',
          unit: 'm',
          why: 'Zentraler Wert für die Einstufung des Gebäudes — bei sehr hohen Gebäuden gelten eigene Hochhaus-Regeln.',
          hint: 'Höhendifferenz zwischen der Fußbodenoberkante des höchstgelegenen oberirdischen Geschoßes und der an das Gebäude angrenzenden Geländeoberfläche nach Fertigstellung im Mittel.',
          conditions: [{ param: 'C1', op: 'equals', value: 'building' }],
          writesTo: '/facts/escape_level_m/value',
          foundIn: [FOUND_IN.section, FOUND_IN.fireSafety, FOUND_IN.buildingDescription],
          feeds: 'building_class',
        },
        {
          id: 'C6',
          label: 'Brutto-Grundfläche der oberirdischen Geschoße gesamt (Zielzustand)',
          type: 'number_tri',
          unit: 'm²',
          conditions: [{ param: 'C1', op: 'equals', value: 'building' }],
          writesTo: '/facts/gfa_above_ground/value',
          foundIn: [FOUND_IN.buildingDescription, FOUND_IN.floorPlan, FOUND_IN.energyCertificate],
          feeds: 'building_class',
        },
        {
          id: 'C7',
          core: true,
          label: 'Anzahl Nutzungseinheiten (Wohnungen + Betriebseinheiten, Zielzustand)',
          type: 'number_tri',
          conditions: [{ param: 'C1', op: 'equals', value: 'building' }],
          writesTo: '/facts/use_units/value',
          foundIn: [FOUND_IN.buildingDescription, FOUND_IN.floorPlan, FOUND_IN.permitDecision],
          feeds: 'building_class',
        },
        {
          // v1.0's C7 with INVERTED polarity, so it writes a NEW key:
          // `units_under_400` (ja = alle Einheiten bis 400 m²) stays untouched in
          // stored profiles and `answersFromProfile` bridges it, inverted, into
          // this question. Reusing the old key would silently flip the meaning
          // of every stored answer — and the GK derivation with it.
          id: 'C8',
          label:
            'Gibt es einzelne Wohnungen oder Betriebseinheiten mit mehr als 400 m² Brutto-Grundfläche?',
          type: 'yes_no_open',
          why: 'Hilft bei der Abgrenzung zwischen den Gebäudeklassen — erscheint nur, wenn es für die Einstufung wirklich gebraucht wird.',
          conditions: [
            { param: 'C1', op: 'equals', value: 'building' },
            { param: 'C3', op: 'lte', value: 4 },
          ],
          writesTo: '/facts/units_over_400/value',
          foundIn: [FOUND_IN.floorPlan, FOUND_IN.buildingDescription, FOUND_IN.fireSafety],
          feeds: 'building_class',
        },
        {
          id: 'C9',
          label: 'Gebäudestellung',
          type: 'single_select',
          conditions: [{ param: 'C1', op: 'equals', value: 'building' }],
          options: [
            { value: 'freestanding', label: 'freistehend' },
            { value: 'attached', label: 'angebaut' },
            { value: 'terraced', label: 'Reihenhaus' },
          ],
          writesTo: '/facts/building_position/value',
          foundIn: [FOUND_IN.sitePlan, FOUND_IN.submissionSitePlan, FOUND_IN.buildingDescription],
          feeds: 'building_class',
        },
        {
          id: 'C9_zugang',
          label:
            'An mindestens drei Seiten auf eigenem Grund oder von Verkehrsflächen für die Feuerwehr zugänglich?',
          type: 'yes_no_open',
          why: 'Unterscheidet bei freistehenden Gebäuden zwischen Gebäudeklasse 1 und 2 (OIB-Begriffsbestimmungen).',
          conditions: [
            { param: 'C1', op: 'equals', value: 'building' },
            { param: 'C9', op: 'equals', value: 'freestanding' },
          ],
          writesTo: '/facts/access_three_sides/value',
          feeds: 'building_class',
          foundIn: [FOUND_IN.sitePlan, FOUND_IN.submissionSitePlan],
        },
        {
          // Multi-select since v1.1 (a building can combine structures); the
          // storage key stays `construction_method` — legacy single values are mapped by
          // the `answersFromProfile` bridge.
          id: 'C10',
          label: 'Tragstruktur / Bauweise (Mehrfachauswahl bei Kombination)',
          type: 'multi_select',
          why: 'Die Bauweise — besonders Holzbau — beeinflusst die Brandschutzanforderungen deutlich; Kombinationen bitte zusätzlich kurz beschreiben.',
          conditions: [{ param: 'C1', op: 'equals', value: 'building' }],
          options: [
            { value: 'masonry_solid', label: 'Mauerwerk / Massivbau' },
            { value: 'reinforced_concrete', label: 'Stahlbeton' },
            { value: 'timber', label: 'Holzbau' },
            { value: 'steel', label: 'Stahlbau' },
            { value: 'open', label: 'noch offen' },
          ],
          writesTo: '/facts/construction_method/value',
          foundIn: [FOUND_IN.buildingDescription, FOUND_IN.structural, FOUND_IN.fireSafety],
        },
        {
          id: 'C10_text',
          label: 'Kombination beschreiben (optional)',
          type: 'text',
          optional: true,
          placeholder: 'z. B. EG Stahlbeton, ab 1. OG Holzbau',
          conditions: [{ param: 'C1', op: 'equals', value: 'building' }],
          writesTo: '/facts/construction_method_description/value',
        },
        {
          id: 'C11',
          label: 'Konditionierung',
          type: 'single_select',
          why: 'Energieanforderungen und Energieausweis betreffen vor allem beheizte oder gekühlte Gebäude.',
          conditions: [{ param: 'C1', op: 'equals', value: 'building' }],
          options: [
            { value: 'heated', label: 'beheizt' },
            { value: 'heated_cooled', label: 'beheizt + gekühlt' },
            { value: 'partly_conditioned', label: 'teilkonditioniert' },
            { value: 'unconditioned', label: 'unkonditioniert' },
          ],
          writesTo: '/facts/conditioning/value',
          foundIn: [FOUND_IN.energyCertificate, FOUND_IN.buildingDescription],
        },
        {
          id: 'C_GK_CONFIRM',
          label: 'Gebäudeklasse',
          type: 'info_placeholder',
          derives: 'building_class',
          hint: 'Die Gebäudeklasse folgt aus Fluchtniveau, Geschoßanzahl, Fläche und Nutzung — immer auf Basis der Zielgeometrie. Sie wird hier noch nicht automatisch gesetzt. Solange sie im Brief offen ist, fragt Piloti nach, bevor eine Anforderung zitiert wird, die an der Klasse hängt.',
          conditions: [{ param: 'C1', op: 'equals', value: 'building' }],
        },
      ],
    },
    // ------------------------------------------------------------------ D
    {
      id: 'D',
      title: 'Nutzungen',
      scope: 'bauwerk',
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
          foundIn: [FOUND_IN.buildingDescription, FOUND_IN.floorPlan, FOUND_IN.permitDecision],
          feeds: 'building_class',
        },
        {
          id: 'DX1',
          core: true,
          label: 'Ist das Bauwerk (teilweise) öffentlich zugänglich / mit Publikumsverkehr?',
          type: 'yes_no_open',
          why: 'Öffentlich zugängliche Bereiche bringen typischerweise Barrierefreiheitsanforderungen mit sich.',
          writesTo: '/facts/public_access/value',
          foundIn: [FOUND_IN.buildingDescription, FOUND_IN.permitDecision],
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
    },
    // ------------------------------------------------------------------ E
    {
      id: 'E',
      title: 'Technik & Energie',
      scope: 'bauwerk',
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
    },
    // ------------------------------------------------------------------ F
    {
      id: 'F',
      title: 'Verfahren & Sonderrecht',
      scope: 'projekt',
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
    },
    // ------------------------------------------------------------------ G
    {
      id: 'G',
      title: 'Projektkontext',
      scope: 'projekt',
      description:
        'Geführter Freitext: alles, was der Assistent über die Zahlen hinaus wissen sollte. Alle Felder optional — je mehr Kontext, desto besser.',
      questions: [
        {
          // v1.0's G1 + G2; the legacy `context_plot` text is bridged
          // into this field. G5 + G6 merged into G4 the same way.
          id: 'G1',
          core: true,
          label: 'Projektbeschreibung, Entwurfsidee & Umfeld',
          type: 'textarea',
          optional: true,
          placeholder:
            'Was ist das Projekt in 3–10 Sätzen? Städtebauliche Setzung, Konzept, Materialität, Besonderheiten von Grundstück und Nachbarschaft …',
          writesTo: '/facts/context_description/value',
        },
        {
          id: 'G2',
          label: 'Ziele & Prioritäten der Bauherrschaft',
          type: 'textarea',
          optional: true,
          placeholder:
            'Kosten- und Terminrahmen, Nachhaltigkeitsambition, Flexibilität, besondere Wünsche …',
          writesTo: '/facts/context_goals/value',
        },
        {
          id: 'G3',
          label: 'Bekannte Konfliktpunkte & Risiken',
          type: 'textarea',
          optional: true,
          placeholder: 'Nachbarn, Behördenvorgespräche, technische Risiken, Widmungskonflikte …',
          writesTo: '/facts/context_conflicts/value',
        },
        {
          id: 'G4',
          label: 'Sonderlösungen, Abweichungen & Sonstiges',
          type: 'textarea',
          optional: true,
          placeholder:
            'Geplante Abweichungen (z. B. Brandschutzkonzept mit Kompensation) und alles Weitere für den Assistenten.',
          writesTo: '/facts/context_special_solutions/value',
        },
      ],
    },
    // ------------------------------------------------------------------ I
    //
    // Placed BEFORE the summary, which is where the handover concept puts it
    // last. Deliberate: Bestandspläne and the Bebauungsplan are INPUTS to the
    // Modul B and C answers. Asking for geometry from memory and only then
    // asking for the plan that contains it gets the order backwards. The
    // module letter follows the concept so the two can be read side by side.
    //
    // It carries no questions. The slots are generated from the role registry
    // (`document-roles.ts`) and rendered by the wizard, so adding a role is one
    // entry there rather than a question here plus a component.
    {
      id: 'I',
      title: 'Projektgrundlagen',
      scope: 'projekt',
      description:
        'Alles, was schon existiert. Piloti nutzt diese Unterlagen als Grundlage für jede Antwort zu diesem Projekt — und sagt Ihnen, was noch fehlt.',
      questions: [],
    },
    // ------------------------------------------------------------------ H
    {
      id: 'H',
      title: 'Zusammenfassung',
      scope: 'projekt',
      description:
        'Ihre Angaben im Überblick. Prüfen Sie alles, bevor das Projektprofil an Piloti übergeben wird.',
      questions: [],
    },
  ],
}

// ---------------------------------------------------------------------------
// Scope helpers — the four-scope model layered onto the flat profile store.
// ---------------------------------------------------------------------------

/** A building's instance id is this prefix and its number: `bldg1`, `bldg2`. */
export const BUILDING_ID_PREFIX = 'bldg'

/** The instance id in an answer or storage key: `…@bldg2`, at the end, before another `@` or before `__`. */
export const BUILDING_ID_IN_KEY = new RegExp(`@(${BUILDING_ID_PREFIX}\\d+)(?:@|$)`)
const BUILDING_ID_IN_ANSWER_KEY = new RegExp(`@(${BUILDING_ID_PREFIX}\\d+)(?:@|$|__)`)

/** The number in an instance id, to put buildings in the order they were added. */
export function buildingNumber(id: string): number {
  return Number(id.slice(BUILDING_ID_PREFIX.length))
}

const BUILDING_ID = new RegExp(`^${BUILDING_ID_PREFIX}[1-9]\\d*$`)

/** Whether `id` is a building instance id (`bldg1`). */
export function isBuildingId(id: string): boolean {
  return BUILDING_ID.test(id)
}

/** The short tag a person sees for a building without a name: „BW1" (Bauwerk 1), whatever the stored id is. */
export function buildingTag(id: string): string {
  return `BW${buildingNumber(id)}`
}

/** A repeatable building instance. */
export interface BuildingInstance {
  id: string
  name: string
}

export function defaultBuildings(): BuildingInstance[] {
  return [{ id: `${BUILDING_ID_PREFIX}1`, name: 'Bauwerk 1' }]
}

/** The wizard's answer-state key for a question in a given scope instance. */
export function answerKeyFor(questionId: string, buildingId?: string, zoneKey?: string): string {
  let key = questionId
  if (buildingId) key += `@${buildingId}`
  if (zoneKey) key += `@${zoneKey}`
  return key
}

/**
 * The building an answer key belongs to, or null for a project-scope one.
 *
 * The inverse of {@link answerKeyFor}, kept beside it so the two cannot drift
 * about what the separator means. A document-role question needs this: a
 * `bauwerk` role has to name its building, and the wizard only knows which
 * building it is rendering through the key.
 */
export function buildingIdFromAnswerKey(answerKey: string): string | null {
  const [, buildingId] = answerKey.split('@')
  return buildingId ?? null
}

/** A building's name in the wizard's answer state (the browser draft); the profile keeps it as the `building_name` fact. */
const BUILDING_NAME_ANSWER_PREFIX = '__building_name@'

/** The sibling key under which a number_tri question stores its answer mode. */
export function modeKeyFor(answerKey: string): string {
  return `${answerKey}__mode`
}

/** Map a question id to its module scope (projekt/grundstueck/bauwerk). */
function scopeOfQuestion(questionId: string): ProjectIntakeScope | null {
  for (const stage of projectIntakeDefinitionV1.stages) {
    if (stage.questions.some((q) => q.id === questionId)) return stage.scope
    if (stage.zoneCommon?.some((q) => q.id === questionId)) return 'bauwerk'
    for (const def of Object.values(stage.zoneDefinitions ?? {})) {
      if (def.questions.some((q) => q.id === questionId)) return 'bauwerk'
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Shared intake helpers — pure and isomorphic; used by the wizard and server.
// ---------------------------------------------------------------------------

/**
 * The validated `federal_state` token vocabulary, read straight off the A2_land
 * question's own options so it can never drift from what the wizard offers.
 * (Backlog T3-9: mirrored, not shared, by the Python backend's
 * `project_context._FEDERAL_STATE_TOKENS`.)
 */
export const FEDERAL_STATE_TOKENS: readonly string[] = (() => {
  const question = flattenIntakeQuestions(projectIntakeDefinitionV1).find((q) => q.id === 'A2_land')
  return question?.options?.map((option) => option.value) ?? []
})()

/** Whether `token` is a recognized `federal_state` (A2_land) intake answer. */
export function isValidFederalStateToken(token: string): boolean {
  return FEDERAL_STATE_TOKENS.includes(token)
}

export const COUNTRY_TOKENS: readonly string[] = (() => {
  const question = flattenIntakeQuestions(projectIntakeDefinitionV1).find(
    (q) => q.id === 'A2_country'
  )
  return question?.options?.map((option) => option.value) ?? []
})()

export function isValidCountryToken(token: string): boolean {
  return COUNTRY_TOKENS.includes(token)
}

/**
 * Whether a question is currently relevant given the answers collected so far.
 * Conditions are AND-combined. `param` is resolved within `instanceId`'s scope
 * (a building question's condition on a building param reads that building's
 * answer), falling back to the project-global answer for non-building params.
 */
export function evaluateIntakeCondition(
  question: ProjectIntakeQuestion,
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string
): boolean {
  return evaluateIntakeConditions(question.conditions, answers, instanceId)
}

/**
 * The same evaluation, given the conditions directly rather than a question.
 *
 * Exported because conditions are no longer only a question's: document roles
 * (`document-roles.ts`) carry a `recommendedWhen` list in this language so the
 * Modul I checklist is data rather than bespoke UI code. Sharing the evaluator
 * is what stops the checklist and the questions ever disagreeing about what a
 * project is.
 *
 * An empty or absent list means "always", which is what a question with no
 * conditions means.
 */
export function evaluateIntakeConditions(
  conditions: ProjectIntakeCondition[] | undefined,
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string
): boolean {
  if (!conditions || conditions.length === 0) return true
  return conditions.every((cond) => evaluateSingleCondition(cond, answers, instanceId))
}

function answerIncludesAny(
  answer: ProjectPrimitiveValue | undefined,
  value: ProjectIntakeCondition['value']
): boolean {
  const needles = Array.isArray(value) ? value : value !== undefined ? [String(value)] : []
  if (Array.isArray(answer)) return answer.some((v) => needles.includes(String(v)))
  return typeof answer === 'string' && needles.includes(answer)
}

function evaluateSingleCondition(
  cond: ProjectIntakeCondition,
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string
): boolean {
  // Resolve which answer key this param lives under: a building-scope param is
  // read from the current building instance; everything else is project-global.
  const paramScope = scopeOfQuestion(cond.param)
  const key = paramScope === 'bauwerk' && instanceId ? `${cond.param}@${instanceId}` : cond.param
  const answer = answers[key]

  switch (cond.op) {
    case 'not_empty':
      return isIntakeAnswerProvided(answer)
    case 'includes_any':
      return answerIncludesAny(answer, cond.value)
    case 'excludes_any':
      return !answerIncludesAny(answer, cond.value)
    case 'lte': {
      // Only a PRESENT, non-'offen' value can satisfy a numeric bound: a
      // question gated on "höchstens 4 Geschoße" must not appear while the
      // storey count is unknown or explicitly left open (spec conventions).
      if (!isIntakeAnswerProvided(answer)) return false
      if (answers[modeKeyFor(key)] === 'offen') return false
      const numeric = typeof answer === 'number' ? answer : Number(answer)
      return typeof cond.value === 'number' && Number.isFinite(numeric) && numeric <= cond.value
    }
    case 'equals':
    default: {
      if (Array.isArray(answer))
        return cond.value !== undefined && answer.includes(cond.value as string)
      return answer === cond.value
    }
  }
}

/** All questions across every stage (including zone questions), in definition order. */
export function flattenIntakeQuestions(
  definition: ProjectIntakeDefinition
): ProjectIntakeQuestion[] {
  const out: ProjectIntakeQuestion[] = []
  for (const stage of definition.stages) {
    out.push(...stage.questions)
    if (stage.zoneCommon) out.push(...stage.zoneCommon)
    for (const def of Object.values(stage.zoneDefinitions ?? {})) out.push(...def.questions)
  }
  return out
}

/** Look up a question by its stable id anywhere in the definition. */
export function findIntakeQuestion(
  definition: ProjectIntakeDefinition,
  questionId: string
): ProjectIntakeQuestion | undefined {
  return flattenIntakeQuestions(definition).find((q) => q.id === questionId)
}

/**
 * The distinct scope instances (buildings) implied by the current answer state.
 * Reconstructed from `@bldgN`-suffixed keys plus any stored building names, so an
 * edit session can rebuild the building list the same way the wizard held it.
 */
export function buildingsFromAnswers(
  answers: Record<string, ProjectPrimitiveValue>
): BuildingInstance[] {
  const ids = new Set<string>()
  for (const key of Object.keys(answers)) {
    const match = key.match(BUILDING_ID_IN_ANSWER_KEY)
    if (match) ids.add(match[1])
  }
  const sorted = [...ids].sort((a, b) => buildingNumber(a) - buildingNumber(b))
  if (sorted.length === 0) return defaultBuildings()
  return sorted.map((id, i) => {
    const stored = answers[`${BUILDING_NAME_ANSWER_PREFIX}${id}`]
    return { id, name: typeof stored === 'string' && stored ? stored : `Bauwerk ${i + 1}` }
  })
}

/**
 * Remove answers for conditional questions whose visibility condition no longer
 * holds — across every scope instance. Recursive: dropping one answer can turn a
 * chained condition false. Returns the same reference when nothing changed.
 */
export function pruneStaleConditionalAnswers(
  answers: Record<string, ProjectPrimitiveValue>,
  definition: ProjectIntakeDefinition | null | undefined
): Record<string, ProjectPrimitiveValue> {
  if (!definition) return answers
  const buildings = buildingsFromAnswers(answers)
  let current = answers
  let changedAny = false

  for (;;) {
    let changedThisPass = false
    let next: Record<string, ProjectPrimitiveValue> | null = null

    const dropIfOrphaned = (
      question: ProjectIntakeQuestion,
      answerKey: string,
      instanceId?: string
    ) => {
      if (!question.conditions || question.conditions.length === 0) return
      const hasAnswer = answerKey in current || modeKeyFor(answerKey) in current
      if (!hasAnswer) return
      if (evaluateIntakeCondition(question, current, instanceId)) return
      if (!next) next = { ...current }
      delete next[answerKey]
      delete next[modeKeyFor(answerKey)]
      changedThisPass = true
    }

    for (const stage of definition.stages) {
      if (stage.scope === 'bauwerk') {
        for (const building of buildings) {
          for (const q of stage.questions) dropIfOrphaned(q, answerKeyFor(q.id, building.id), building.id)
        }
      } else {
        for (const q of stage.questions) dropIfOrphaned(q, q.id)
      }
    }

    if (!changedThisPass) break
    if (next) current = next
    changedAny = true
  }

  return changedAny ? current : answers
}

/** Whether an answer counts as provided (non-empty). */
export function isIntakeAnswerProvided(answer: ProjectPrimitiveValue | undefined): boolean {
  if (answer === undefined || answer === null || answer === '') return false
  if (Array.isArray(answer)) return answer.length > 0
  return true
}

interface WriteTarget {
  scope: 'facts' | 'goals'
  key: string
}

/** Resolve the fact/goal base key a question writes to. */
function resolveWriteTarget(writesTo: string | undefined): WriteTarget | null {
  if (!writesTo) return null
  const factMatch = writesTo.match(/^\/facts\/([^/]+)/)
  if (factMatch) return { scope: 'facts', key: factMatch[1] }
  const goalMatch = writesTo.match(/^\/goals\/([^/]+)/)
  if (goalMatch) return { scope: 'goals', key: goalMatch[1] }
  return null
}

/** Namespace a base storage key with the building/zone instance it belongs to. */
function instanceStorageKey(baseKey: string, buildingId?: string, zoneKey?: string): string {
  let key = baseKey
  if (buildingId) key += `@${buildingId}`
  if (zoneKey) key += `@${zoneKey}`
  return key
}

const NOW_SOURCE = 'onboarding' as const

interface BuildContext {
  now: string
  patch: ProjectProfilePatchOperation[]
  unknowns: string[]
}

/**
 * Emit the right profile entry for a single answered/-unanswered question,
 * mapping the answer mode onto the three-state profile model:
 *   • confirmed value   → fact
 *   • estimated value   → assumption (unconfirmed)
 *   • open / unanswered → unknown
 */
function emitAnswer(
  ctx: BuildContext,
  question: ProjectIntakeQuestion,
  answerKey: string,
  storageKey: string,
  target: WriteTarget,
  answers: Record<string, ProjectPrimitiveValue>
): void {
  const raw = answers[answerKey]

  if (question.type === 'yes_no_open') {
    if (raw === 'ja' || raw === 'nein') {
      addFact(ctx, target, storageKey, raw === 'ja')
    } else {
      ctx.unknowns.push(storageKey)
    }
    return
  }

  if (question.type === 'number_tri') {
    const mode = (answers[modeKeyFor(answerKey)] as IntakeAnswerMode) ?? 'wert'
    if (mode === 'offen' || !isIntakeAnswerProvided(raw)) {
      ctx.unknowns.push(storageKey)
      return
    }
    const numeric = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(numeric)) {
      ctx.unknowns.push(storageKey)
      return
    }
    if (mode === 'geschaetzt') {
      ctx.patch.push({
        op: 'add',
        path: `/assumptions/${encodeKey(storageKey)}`,
        value: {
          value: numeric,
          status: 'unconfirmed',
          reason: 'Während der Erhebung geschätzt',
          source: 'onboarding_default',
          updatedAt: ctx.now,
        },
      })
    } else {
      addFact(ctx, target, storageKey, numeric)
    }
    return
  }

  // Plain types.
  if (!isIntakeAnswerProvided(raw)) {
    ctx.unknowns.push(storageKey)
    return
  }
  const value: ProjectPrimitiveValue = Array.isArray(raw) ? [...raw] : raw
  addFact(ctx, target, storageKey, value)
}

function addFact(
  ctx: BuildContext,
  target: WriteTarget,
  storageKey: string,
  value: ProjectPrimitiveValue
): void {
  if (target.scope === 'goals') {
    ctx.patch.push({ op: 'add', path: `/goals/${encodeKey(storageKey)}`, value })
  } else {
    ctx.patch.push({
      op: 'add',
      path: `/facts/${encodeKey(storageKey)}`,
      value: { value, confidence: 'confirmed', source: NOW_SOURCE, updatedAt: ctx.now },
    })
  }
}

/** JSON-pointer-encode a storage key (the only special char we use is `~`/`/`). */
function encodeKey(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1')
}

/**
 * Build a {@link ProjectProfile} from collected intake answers, expanding the
 * building scope over every building and the zone scope over every selected use.
 */
export function buildIntakeProfile(
  answers: Record<string, ProjectPrimitiveValue>,
  definition: ProjectIntakeDefinition,
  options?: {
    projectName?: string
    buildings?: BuildingInstance[]
  }
): ProjectProfile {
  const ctx: BuildContext = { now: new Date().toISOString(), patch: [], unknowns: [] }
  const buildings = options?.buildings ?? buildingsFromAnswers(answers)

  // The name may have been captured at project creation; seed it so A1 is never
  // asked twice, but let an explicit A1 answer (below) override it.
  const projectName = options?.projectName?.trim()
  if (projectName && !isIntakeAnswerProvided(answers['A1'])) {
    ctx.patch.push({
      op: 'add',
      path: '/facts/project_name',
      value: {
        value: projectName,
        confidence: 'confirmed',
        source: NOW_SOURCE,
        updatedAt: ctx.now,
      },
    })
  }

  // Record building names so an edit session can rebuild the list.
  if (buildings.length > 1 || buildings[0]?.name !== 'Bauwerk 1') {
    for (const building of buildings) {
      ctx.patch.push({
        op: 'add',
        path: `/facts/${encodeKey(`building_name@${building.id}`)}`,
        value: { value: building.name, confidence: 'confirmed', source: NOW_SOURCE, updatedAt: ctx.now },
      })
    }
  }

  for (const stage of definition.stages) {
    if (stage.scope === 'bauwerk') {
      for (const building of buildings) emitStageForBuilding(ctx, stage, building, answers)
    } else {
      for (const question of stage.questions) {
        const target = resolveWriteTarget(question.writesTo)
        if (!target) continue
        if (!evaluateIntakeCondition(question, answers)) continue
        emitAnswer(ctx, question, question.id, target.key, target, answers)
      }
    }
  }

  const federalStatePath = '/facts/federal_state'

  // A patch value is either a bare primitive or a fact envelope
  // (`{ value, confidence, source, updatedAt }`) depending on which producer
  // emitted it; both forms have to yield the same token here.
  const unwrapFactValue = (value: unknown): unknown =>
    typeof value === 'object' && value !== null && 'value' in value
      ? (value as { value: unknown }).value
      : value

  // Derive country from federal_state for legacy profiles.
  const hasCountry = ctx.patch.some((p) => p.path === '/facts/country')
  const federalStatePatch = ctx.patch.find((p) => p.path === federalStatePath)
  if (!hasCountry && federalStatePatch) {
    const bToken = unwrapFactValue(federalStatePatch.value)
    if (
      typeof bToken === 'string' &&
      bToken !== 'outside_austria' &&
      (FEDERAL_STATE_TOKENS as readonly string[]).includes(bToken)
    ) {
      ctx.patch.push({
        op: 'add',
        path: '/facts/country',
        value: { value: 'at', confidence: 'confirmed', source: NOW_SOURCE, updatedAt: ctx.now },
      })
    }
  }

  // Derive federal_state for non-AT country.
  const countryFact = ctx.patch.find((p) => p.path === '/facts/country')
  const hasFederalState = ctx.patch.some((p) => p.path === federalStatePath)
  const countryValue = unwrapFactValue(countryFact?.value)
  if (countryFact && typeof countryValue === 'string' && countryValue !== 'at' && !hasFederalState) {
    ctx.patch.push({
      op: 'add',
      path: federalStatePath,
      value: {
        value: 'outside_austria',
        confidence: 'confirmed',
        source: NOW_SOURCE,
        updatedAt: ctx.now,
      },
    })
  }

  for (const key of ctx.unknowns) {
    ctx.patch.push({ op: 'add', path: '/unknowns/-', value: key })
  }

  return applyProjectProfilePatch(emptyProjectProfile(), ctx.patch)
}

function emitStageForBuilding(
  ctx: BuildContext,
  stage: ProjectIntakeStage,
  building: BuildingInstance,
  answers: Record<string, ProjectPrimitiveValue>
): void {
  for (const question of stage.questions) {
    const target = resolveWriteTarget(question.writesTo)
    if (!target) continue
    if (!evaluateIntakeCondition(question, answers, building.id)) continue
    const answerKey = answerKeyFor(question.id, building.id)
    emitAnswer(ctx, question, answerKey, instanceStorageKey(target.key, building.id), target, answers)
  }

  // Zones: one per selected use in this building's D0.
  if (!stage.zoneDefinitions && !stage.zoneCommon) return
  const selectedUses = answers[answerKeyFor('D0', building.id)]
  if (!Array.isArray(selectedUses)) return

  for (const use of selectedUses) {
    const zoneQuestions = [
      ...(stage.zoneCommon ?? []),
      ...(stage.zoneDefinitions?.[use]?.questions ?? []),
    ]
    for (const question of zoneQuestions) {
      const target = resolveWriteTarget(question.writesTo)
      if (!target) continue
      const answerKey = answerKeyFor(question.id, building.id, use)
      emitAnswer(
        ctx,
        question,
        answerKey,
        instanceStorageKey(target.key, building.id, use),
        target,
        answers
      )
    }
  }
}

/** Two profile values are the same when they are equal; a multi-select's order is not part of the answer. */
function sameProfileValue(a: ProjectPrimitiveValue, b: ProjectPrimitiveValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const sortedB = [...b].sort()
    return a.length === b.length && [...a].sort().every((item, index) => item === sortedB[index])
  }
  return a === b
}

/**
 * What a rebuilt entry keeps of what the previous profile knew about its key
 * (ADR-0111): the `evidence` when the value is unchanged, so confirming a
 * suggestion in the wizard keeps the page it was found on, and the
 * `alternatives` a reading found, except one that equals the value now chosen.
 * The wizard builds values without either, so without this a save would erase
 * both. A rebuilt estimate (`onboarding_default`) is the person's own figure
 * and keeps no evidence, only the alternatives.
 */
function carryOverProvenance<Entry extends ProjectFact | ProjectAssumption>(
  built: Record<string, Entry>,
  previous: ProjectProfile,
  options: { evidence: boolean }
): Record<string, Entry> {
  return Object.fromEntries(
    Object.entries(built).map(([key, entry]) => {
      const before = previous.facts[key] ?? previous.assumptions[key]
      if (!before) return [key, entry]
      const alternatives = before.alternatives?.filter(
        (alternative) => !sameProfileValue(alternative.value, entry.value)
      )
      const carried: Entry = { ...entry }
      if (
        options.evidence &&
        before.evidence?.length &&
        sameProfileValue(before.value, entry.value)
      )
        carried.evidence = before.evidence
      if (alternatives?.length) carried.alternatives = alternatives
      return [key, carried]
    })
  )
}

/**
 * Merge a freshly wizard-built profile over the previously stored one so a
 * whole-profile PUT can never destroy knowledge the wizard doesn't own
 * (agent-recorded novel facts/goals/unknowns, assumptions).
 *
 * Intake-owned keys are matched by their base key ignoring any `@bldgN` / `@zone`
 * suffix, so every scope instance the wizard produced is treated as wizard-owned.
 */
export function mergeIntakeProfile(
  built: ProjectProfile,
  previous: ProjectProfile | null | undefined,
  definition: ProjectIntakeDefinition
): ProjectProfile {
  if (!previous) return built

  const intakeFactBaseKeys = new Set<string>(['project_name', 'building_name'])
  const intakeGoalBaseKeys = new Set<string>()
  for (const question of flattenIntakeQuestions(definition)) {
    const target = resolveWriteTarget(question.writesTo)
    if (!target) continue
    ;(target.scope === 'goals' ? intakeGoalBaseKeys : intakeFactBaseKeys).add(target.key)
  }
  const baseKeyOf = (key: string): string => key.split('@')[0]
  const isIntakeFact = (key: string) => intakeFactBaseKeys.has(baseKeyOf(key))
  const isIntakeGoal = (key: string) => intakeGoalBaseKeys.has(baseKeyOf(key))

  const facts = {
    ...Object.fromEntries(Object.entries(previous.facts).filter(([key]) => !isIntakeFact(key))),
    ...carryOverProvenance(built.facts, previous, { evidence: true }),
  }
  const goals = {
    ...Object.fromEntries(Object.entries(previous.goals).filter(([key]) => !isIntakeGoal(key))),
    ...built.goals,
  }
  const assumptions = {
    ...Object.fromEntries(
      Object.entries(previous.assumptions).filter(
        ([key, assumption]) =>
          // A reading's suggestion is not the wizard's to delete: it stays unless
          // this save answers the key (a fact) or estimates it (an assumption).
          // Everything else under an intake key is the wizard's own and is rebuilt.
          (!isIntakeFact(key) && !isIntakeGoal(key)) ||
          (assumption.source === 'agent_suggested' &&
            !(key in built.facts) &&
            !(key in built.assumptions))
      )
    ),
    ...carryOverProvenance(built.assumptions, previous, { evidence: false }),
  }

  const unknowns = [...built.unknowns]
  for (const key of previous.unknowns) {
    if (isIntakeFact(key) || isIntakeGoal(key)) continue
    if (unknowns.includes(key)) continue
    if (key in facts || key in goals) continue
    unknowns.push(key)
  }

  return { facts, goals, unknowns, assumptions }
}

/**
 * Reverse of {@link buildIntakeProfile}: seed wizard answers (and the building
 * list) from an already-saved profile so re-entering intake opens prefilled.
 */
export function answersFromProfile(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition
): {
  answers: Record<string, ProjectPrimitiveValue>
  buildings: BuildingInstance[]
} {
  const answers: Record<string, ProjectPrimitiveValue> = {}

  // Rebuild the building list from stored building_name facts / suffixed keys.
  const foundIds = new Set<string>()
  const collectId = (key: string) => {
    const m = key.match(BUILDING_ID_IN_KEY)
    if (m) foundIds.add(m[1])
  }
  Object.keys(profile.facts).forEach(collectId)
  Object.keys(profile.assumptions).forEach(collectId)
  profile.unknowns.forEach(collectId)
  const buildings: BuildingInstance[] =
    foundIds.size === 0
      ? defaultBuildings()
      : [...foundIds]
          .sort((a, b) => buildingNumber(a) - buildingNumber(b))
          .map((id, i) => {
            const stored = profile.facts[`building_name@${id}`]?.value
            return { id, name: typeof stored === 'string' && stored ? stored : `Bauwerk ${i + 1}` }
          })

  const readInto = (question: ProjectIntakeQuestion, answerKey: string, storageKey: string) => {
    const target = resolveWriteTarget(question.writesTo)
    if (!target) return

    // number_tri: fact → wert, assumption → geschaetzt, unknown → offen.
    if (question.type === 'number_tri') {
      const fact = profile.facts[storageKey]
      const assumption = profile.assumptions[storageKey]
      if (fact !== undefined && typeof fact.value === 'number') {
        answers[answerKey] = fact.value
        answers[modeKeyFor(answerKey)] = 'wert'
      } else if (assumption !== undefined && typeof assumption.value === 'number') {
        answers[answerKey] = assumption.value
        answers[modeKeyFor(answerKey)] = 'geschaetzt'
      } else if (profile.unknowns.includes(storageKey)) {
        answers[modeKeyFor(answerKey)] = 'offen'
      }
      return
    }

    // yes_no_open: boolean fact → ja/nein, unknown → offen.
    if (question.type === 'yes_no_open') {
      const fact = profile.facts[storageKey]
      if (fact !== undefined && typeof fact.value === 'boolean') {
        answers[answerKey] = fact.value ? 'ja' : 'nein'
      } else if (profile.unknowns.includes(storageKey)) {
        answers[answerKey] = 'offen'
      }
      return
    }

    let value: ProjectPrimitiveValue | undefined =
      target.scope === 'goals' ? profile.goals?.[storageKey] : profile.facts?.[storageKey]?.value
    if (value === undefined || value === null) return
    if (question.type === 'multi_select' && typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value)
        if (Array.isArray(parsed)) value = parsed as string[]
      } catch {
        /* keep as-is */
      }
    }
    answers[answerKey] = value
  }

  for (const stage of definition.stages) {
    if (stage.scope === 'bauwerk') {
      for (const building of buildings) {
        for (const q of stage.questions) {
          const target = resolveWriteTarget(q.writesTo)
          if (target) readInto(q, answerKeyFor(q.id, building.id), instanceStorageKey(target.key, building.id))
        }
        const uses = answers[answerKeyFor('D0', building.id)]
        if (Array.isArray(uses)) {
          for (const use of uses) {
            const zoneQs = [
              ...(stage.zoneCommon ?? []),
              ...(stage.zoneDefinitions?.[use]?.questions ?? []),
            ]
            for (const q of zoneQs) {
              const target = resolveWriteTarget(q.writesTo)
              if (target)
                readInto(
                  q,
                  answerKeyFor(q.id, building.id, use),
                  instanceStorageKey(target.key, building.id, use)
                )
            }
          }
        }
      }
    } else {
      for (const q of stage.questions) {
        const target = resolveWriteTarget(q.writesTo)
        if (target) readInto(q, q.id, target.key)
      }
    }
  }

  applyLegacyAnswerBridges(profile, answers, buildings)

  return { answers, buildings }
}

// ---------------------------------------------------------------------------
// Legacy bridges: v1.0-catalog profiles opened by the v1.2 catalog.
//
// Storage keys are id-independent, so the v1.1 renumbering costs nothing. What
// remains are the places where a MEANING moved: merged questions, the
// project→building scope move of the Bestand block, and the one inversion.
// Bridges only PREFILL wizard answers — the stored profile is untouched until
// the user saves, at which point the answers re-emit under the new shape and
// `mergeIntakeProfile` retires the intake-owned legacy keys.
// ---------------------------------------------------------------------------

/** The four v1.0 booleans that v1.2's `E2` multi-select absorbed. */
const LEGACY_TECHNOLOGY_KEYS = ['pv', 'ventilation', 'cooling', 'infiltration'] as const

/** v1.0 `work_type` (then `work_type`) → the v1.2 `CB4` measure it corresponds to. */
const LEGACY_PLANNED_WORK_TO_MEASURE: Record<string, string> = {
  refurbishment: 'envelope_refurbishment',
  conversion: 'interior_conversion',
  extension: 'extension',
  change_of_use: 'change_of_use',
  demolition: 'partial_demolition',
}

function legacyBoolean(profile: ProjectProfile, key: string): boolean | undefined {
  const value = profile.facts[key]?.value
  return typeof value === 'boolean' ? value : undefined
}

function applyLegacyAnswerBridges(
  profile: ProjectProfile,
  answers: Record<string, ProjectPrimitiveValue>,
  buildings: BuildingInstance[]
): void {
  // --- Bestand block (v1.0 A6/A7/A9/A10 → CB1/CB3/CB5/CB6, project → building).
  // Only bridged into a single-building project: the legacy answer was one
  // project-global statement, and guessing WHICH of several buildings it
  // described would plant a wrong fact. Multi-building projects re-answer per
  // building; the completion checklist surfaces the gap.
  if (buildings.length === 1) {
    const buildingId = buildings[0].id
    const legacyExisting: Array<{ question: string; key: string; numeric: boolean }> = [
      { question: 'CB1', key: 'existing_year_built', numeric: true },
      { question: 'CB3', key: 'heritage_protection', numeric: false },
      { question: 'CB5', key: 'structural_intervention', numeric: false },
      { question: 'CB6', key: 'major_renovation', numeric: false },
    ]
    let bridgedAny = false
    for (const { question, key, numeric } of legacyExisting) {
      const answerKey = answerKeyFor(question, buildingId)
      if (answers[answerKey] !== undefined || answers[modeKeyFor(answerKey)] !== undefined) continue
      if (numeric) {
        const fact = profile.facts[key]?.value
        const assumption = profile.assumptions[key]?.value
        if (typeof fact === 'number') {
          answers[answerKey] = fact
          answers[modeKeyFor(answerKey)] = 'wert'
          bridgedAny = true
        } else if (typeof assumption === 'number') {
          answers[answerKey] = assumption
          answers[modeKeyFor(answerKey)] = 'geschaetzt'
          bridgedAny = true
        }
        continue
      }
      const bool = legacyBoolean(profile, key)
      if (bool !== undefined) {
        answers[answerKey] = bool ? 'ja' : 'nein'
        bridgedAny = true
      } else if (profile.unknowns.includes(key)) {
        // An explicitly-open legacy answer is an answer. Dropping it left
        // `bridgedAny` false, so the C2 gate never opened and the whole
        // Bestand block stayed hidden for a project that had described one.
        answers[answerKey] = 'offen'
        bridgedAny = true
      }
    }
    // A building whose Bestand was described IS a Bestandsgebäude — prefill the
    // gate so the bridged block is visible instead of orphaned behind an
    // unanswered C2.
    const c2Key = answerKeyFor('C2', buildingId)
    if (bridgedAny && answers[c2Key] === undefined) answers[c2Key] = 'existing'

    // CB6 sits behind a CB4 measure as well, and legacy profiles have no CB4.
    // Without one the bridged answer renders nowhere and `buildIntakeProfile`
    // drops it on save. The measures are read off the project's own
    // `work_type` rather than invented: v1.0 only ever ASKED A10 when A5
    // included `sanierung`, so the mapping restates what the old catalog
    // already implied.
    const cb4Key = answerKeyFor('CB4', buildingId)
    const cb6Key = answerKeyFor('CB6', buildingId)
    if (answers[cb6Key] !== undefined && !isIntakeAnswerProvided(answers[cb4Key])) {
      const plannedWork = profile.facts['work_type']?.value
      const measures = new Set<string>()
      if (Array.isArray(plannedWork)) {
        for (const workType of plannedWork) {
          const mapped = LEGACY_PLANNED_WORK_TO_MEASURE[String(workType)]
          if (mapped) measures.add(mapped)
        }
      }
      // CB6 only asks about the hull, so a bridged answer implies hull work
      // even when `work_type` named nothing that maps.
      if (measures.size === 0) measures.add('envelope_refurbishment')
      answers[cb4Key] = [...measures]
    }
  }

  for (const building of buildings) {
    // --- C8 inversion (v1.0 C7 `units_under_400`, ja = alle Einheiten bis 400 m²).
    const c8Key = answerKeyFor('C8', building.id)
    if (answers[c8Key] === undefined) {
      const legacy = profile.facts[`units_under_400@${building.id}`]?.value
      if (typeof legacy === 'boolean') answers[c8Key] = legacy ? 'nein' : 'ja'
      else if (profile.unknowns.includes(`units_under_400@${building.id}`)) answers[c8Key] = 'offen'
    }

    // --- C10 single → multi (`construction_method`): map the legacy single token.
    const c10Key = answerKeyFor('C10', building.id)
    const c10 = answers[c10Key]
    if (typeof c10 === 'string') {
      const mapped: Record<string, string[]> = {
        // `massivbau`, `stahl` and `hybrid` are v1.0 tokens no migration renamed
        // (they are no option of the current question); the others are the
        // current tokens, which is what a v1.0 profile holds after 0159.
        massivbau: ['masonry_solid'],
        timber: ['timber'],
        stahl: ['steel'],
        open: ['open'],
      }
      const replacement = mapped[c10]
      if (replacement) {
        answers[c10Key] = replacement
      } else if (c10 === 'hybrid') {
        // v1.0's `hybrid` named a combination without naming its members, and
        // v1.2 expresses a combination as the multi-select PLUS `C10_text`.
        // Deleting the answer dropped a construction type the user had actually
        // stated: `construction_method` is intake-owned, so `mergeIntakeProfile` removed
        // the stored fact too. It moves into the field built to hold exactly
        // this, and the user refines it when they next open the module.
        answers[c10Key] = ['open']
        const c10TextKey = answerKeyFor('C10_text', building.id)
        if (!isIntakeAnswerProvided(answers[c10TextKey])) {
          answers[c10TextKey] =
            'Hybridbauweise (aus früherer Angabe — Kombination bitte präzisieren)'
        }
      } else {
        delete answers[c10Key]
      }
    }

    // --- E2 fusion: four legacy booleans into `further_technology`.
    const e2Key = answerKeyFor('E2', building.id)
    if (answers[e2Key] === undefined) {
      const technology: string[] = []
      if (legacyBoolean(profile, `pv@${building.id}`)) technology.push('pv')
      if (legacyBoolean(profile, `ventilation@${building.id}`)) technology.push('ventilation')
      if (legacyBoolean(profile, `cooling@${building.id}`)) technology.push('cooling')
      if (legacyBoolean(profile, `infiltration@${building.id}`)) technology.push('infiltration')
      if (technology.length > 0) answers[e2Key] = technology
      else if (
        LEGACY_TECHNOLOGY_KEYS.every((key) => legacyBoolean(profile, `${key}@${building.id}`) === false)
      ) {
        // All four answered and all four "no" is the explicit `keine`, not an
        // unanswered question — otherwise the migration puts a module the user
        // completed back on the completion checklist.
        answers[e2Key] = ['none']
      }
    }
  }

  // --- B4 fusion: legacy Altlast/Baumbestand/Schutzgebiet booleans join the
  // stored `hazard_zones` values (already read into B4 — same key, wider
  // vocabulary).
  const b4Additions: string[] = []
  if (legacyBoolean(profile, 'contaminated_land')) b4Additions.push('contaminated_land')
  if (legacyBoolean(profile, 'tree_stock')) b4Additions.push('tree_stock')
  if (legacyBoolean(profile, 'protected_area')) b4Additions.push('protected_area')
  if (b4Additions.length > 0) {
    const current = Array.isArray(answers['B4']) ? (answers['B4'] as string[]) : []
    const merged = [
      ...current.filter((value) => value !== 'none'),
      ...b4Additions.filter((v) => !current.includes(v)),
    ]
    answers['B4'] = merged
  }

  // --- B6 fusion: Kanal + Trinkwasser + Zufahrt → one Erschließungs-Status.
  // Only when all three were answered; a partial picture stays unanswered
  // rather than guessed.
  if (answers['B6'] === undefined) {
    const sewer = legacyBoolean(profile, 'sewer')
    const water = legacyBoolean(profile, 'drinking_water')
    const access = legacyBoolean(profile, 'fire_brigade_access')
    if (sewer !== undefined && water !== undefined && access !== undefined) {
      const yes = [sewer, water, access].filter(Boolean).length
      // Never 'yes' from these three. The new question also covers electricity,
      // which v1.0 never asked, so claiming full servicing would persist a fact
      // nobody stated. Anything short of all three is honestly 'teilweise';
      // all three leaves the electricity question for the user.
      if (yes === 0) answers['B6'] = 'no'
      else if (yes < 3) answers['B6'] = 'partial'
    }
  }

  // --- B7 fusion: Anschlussgebiet beats bare availability.
  if (answers['B7'] === undefined) {
    if (legacyBoolean(profile, 'district_heating_zone')) answers['B7'] = 'connection_area'
    else {
      const fw = legacyBoolean(profile, 'district_heating')
      if (fw !== undefined) answers['B7'] = fw ? 'available' : 'unavailable'
    }
  }

  // v1.0's A8 (Schutzzone) is deliberately NOT bridged into `B3_bes`.
  //
  // `B3_bes` only renders behind `B2 = ja`, so a bridged value would be
  // invisible for a project with no Bebauungsplan — and then dropped on save,
  // because `buildIntakeProfile` skips a question whose condition is false.
  // Left alone, `old_town_protection_zone` is owned by no current question, so
  // `mergeIntakeProfile` preserves it as an agent-visible fact. Not bridging
  // keeps it; bridging lost it.

  // --- F4 fusion: legacy Zertifizierung tokens are valid F4 values.
  const zert = profile.facts['certification']?.value
  if (typeof zert === 'string' && !['none', 'open'].includes(zert)) {
    const current = Array.isArray(answers['F4']) ? (answers['F4'] as string[]) : []
    if (!current.includes(zert))
      answers['F4'] = [...current.filter((value) => value !== 'none'), zert]
  }

  // --- G merges: appended, never overwritten.
  const appendText = (answerKey: string, key: string) => {
    const legacy = profile.facts[key]?.value
    if (typeof legacy !== 'string' || !legacy.trim()) return
    const current = answers[answerKey]
    if (typeof current !== 'string' || !current.trim()) {
      answers[answerKey] = legacy
      return
    }
    // Idempotent. The legacy key is owned by no current question, so
    // `mergeIntakeProfile` preserves it — and the merged text is already in the
    // answer. Appending unconditionally added another copy on every reopen and
    // save, growing the field without bound.
    if (current.includes(legacy.trim())) return
    answers[answerKey] = `${current}\n\n${legacy}`
  }
  appendText('G1', 'context_plot')
  appendText('G4', 'context_other')
}

/**
 * Title-case a raw snake_case/space-separated profile key as a last-resort human
 * label (e.g. `high_rise_details` -> "High Rise Details").
 */
export function humanizeProfileKey(key: string): string {
  return key
    .split('@')[0]
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Resolve a human label for a raw profile fact/goal key (e.g. `escape_level_m`,
 * or a scoped `escape_level_m@bldg1`) from the intake question that writes it.
 */
export function labelForProfileKey(definition: ProjectIntakeDefinition, key: string): string {
  const base = key.split('@')[0]
  for (const question of flattenIntakeQuestions(definition)) {
    const target = resolveWriteTarget(question.writesTo)
    if (target?.key === base) return question.label
  }
  return humanizeProfileKey(key)
}

/**
 * Server-side vocabulary validation (defense-in-depth for the profile-patch
 * flow): reject add/replace operations whose value violates the intake question
 * that owns the key. Scoped keys (`<base>@bldg1`) resolve to their base question.
 */
export function validateProfilePatchVocabulary(patch: ProjectProfilePatchOperation[]): void {
  for (const operation of patch.map(normalizeProfilePatchOperation)) {
    if (operation.op === 'remove') continue
    const key = extractVocabKey(operation.path)
    if (!key) continue
    const question = questionForKey(key)
    if (!question) continue
    assertVocabulary(question, unwrapPatchValue(operation.value))
  }
}

function extractVocabKey(path: string): string | null {
  const parts = path.split('/')
  const section = parts[1]
  if (section === 'facts' || section === 'assumptions' || section === 'goals') {
    if (parts.length === 3 && parts[2] && parts[2] !== '-') return decodeVocabSegment(parts[2])
    if (
      section !== 'goals' &&
      parts.length === 4 &&
      parts[3] === 'value' &&
      parts[2] &&
      parts[2] !== '-'
    ) {
      return decodeVocabSegment(parts[2])
    }
  }
  return null
}

function questionForKey(key: string): ProjectIntakeQuestion | undefined {
  const base = decodeVocabSegment(key).split('@')[0]
  return flattenIntakeQuestions(projectIntakeDefinitionV1).find(
    (question) => resolveWriteTarget(question.writesTo)?.key === base
  )
}

function unwrapPatchValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return (value as Record<string, unknown>).value
  }
  return value
}

function assertVocabulary(question: ProjectIntakeQuestion, value: unknown): void {
  const label = question.label
  const shown = JSON.stringify(value)
  switch (question.type) {
    case 'single_select': {
      if (
        typeof value !== 'string' ||
        !question.options?.some((option) => option.value === value)
      ) {
        throw new Error(`Invalid value for "${label}": ${shown} is not an allowed option.`)
      }
      return
    }
    case 'multi_select': {
      const allowed = new Set(question.options?.map((option) => option.value) ?? [])
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === 'string' && allowed.has(item))
      ) {
        throw new Error(
          `Invalid value for "${label}": ${shown} is not a subset of the allowed options.`
        )
      }
      return
    }
    case 'yes_no_open':
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new Error(`Invalid value for "${label}": expected true or false, got ${shown}.`)
      }
      return
    }
    case 'number_tri':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Invalid value for "${label}": expected a number, got ${shown}.`)
      }
      return
    }
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string') {
        throw new Error(`Invalid value for "${label}": expected text, got ${shown}.`)
      }
      return
    }
    default:
      return
  }
}

function decodeVocabSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~')
}

/** Human-readable rendering of a single answer, using option labels where available. */
export function formatIntakeAnswer(
  question: ProjectIntakeQuestion,
  answer: ProjectPrimitiveValue | undefined
): string {
  // yes_no_open facts persist as booleans; render them like a boolean here.
  if (
    question.type === 'boolean' ||
    (question.type === 'yes_no_open' && typeof answer === 'boolean')
  ) {
    return answer ? 'Ja' : answer === false ? 'Nein' : '—'
  }
  if (!isIntakeAnswerProvided(answer)) return '—'

  const optionLabel = (value: string): string =>
    question.options?.find((option) => option.value === value)?.label ?? value

  if (question.type === 'multi_select' && Array.isArray(answer)) {
    return answer.map(optionLabel).join(', ')
  }
  if (
    (question.type === 'single_select' || question.type === 'yes_no_open') &&
    typeof answer === 'string'
  ) {
    return optionLabel(answer)
  }
  if (question.type === 'number_tri' && typeof answer === 'number') {
    return question.unit ? `${answer} ${question.unit}` : String(answer)
  }
  return String(answer)
}
