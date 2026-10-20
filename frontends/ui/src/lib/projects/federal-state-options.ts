/**
 * The Bundesland choices of the create dialog when no geocoder is configured:
 * the intake wizard's own `A2_land` options, so the two can never offer
 * different tokens. „Außerhalb Österreichs" is left out: Piloti supports Austria
 * only (`docs/design/agentic-project-intake.md`, „What the ticket asked").
 */

import {
  flattenIntakeQuestions,
  projectIntakeDefinitionV1,
} from '@/lib/project-profile/intake-definition'

export interface FederalStateOption {
  value: string
  label: string
}

export const FEDERAL_STATE_OPTIONS: readonly FederalStateOption[] = (
  flattenIntakeQuestions(projectIntakeDefinitionV1).find((question) => question.id === 'A2_land')?.options ?? []
).filter((option) => option.value !== 'ausserhalb_oesterreichs')
