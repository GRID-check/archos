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
//   • number_tri mode 'value'       → confirmed fact
//   • number_tri mode 'estimated' → unconfirmed assumption (estimated)
//   • number_tri mode 'open'      → unknown
//   • yes_no_open 'yes' / 'no'    → boolean fact
//   • yes_no_open 'open'          → unknown
//
// The stable question `id` is the classification anchor; `writesTo` bridges it to
// a descriptive storage key so the jurisdiction pipeline (facts.federal_state) and
// the LLM-consumed prompt view stay readable. Two bridges are load-bearing and
// MUST NOT change key: A1 → project_name, A2_land → federal_state.
// ---------------------------------------------------------------------------

import { PROJECT_BASIS_STAGE } from './intake-stages/project-basis'
import { PLOT_STAGE } from './intake-stages/plot'
import { BUILDINGS_STAGE } from './intake-stages/buildings'
import { USES_STAGE } from './intake-stages/uses'
import { TECHNOLOGY_STAGE } from './intake-stages/technology'
import { PROCEDURE_STAGE } from './intake-stages/procedure'
import { CONTEXT_STAGE } from './intake-stages/context'
import type { ProjectIntakeDefinition } from './intake-types'
import { PRODUCT_NAME } from '@/lib/brand'

export const projectIntakeDefinitionV1: ProjectIntakeDefinition = {
  version: 5,
  stages: [
    PROJECT_BASIS_STAGE,
    PLOT_STAGE,
    // Spec C0 (Bauwerksliste) is realized by the wizard's building-management
    // UI (duplizierbare Karten, min. 1 building) rather than a question row —
    // rendering it additionally as a question would describe controls sitting
    // directly above it.
    BUILDINGS_STAGE,
    USES_STAGE,
    TECHNOLOGY_STAGE,
    PROCEDURE_STAGE,
    CONTEXT_STAGE,
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
      scope: 'project',
      description:
        'Alles, was schon existiert. ' + PRODUCT_NAME + ' nutzt diese Unterlagen als Grundlage für jede Antwort zu diesem Projekt — und sagt Ihnen, was noch fehlt.',
      questions: [],
    },
    {
      id: 'H',
      title: 'Zusammenfassung',
      scope: 'project',
      description:
        'Ihre Angaben im Überblick. Prüfen Sie alles, bevor das Projektprofil an ' + PRODUCT_NAME + ' übergeben wird.',
      questions: [],
    },
  ],
}
