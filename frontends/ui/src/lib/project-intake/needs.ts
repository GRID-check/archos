/**
 * The information need (`docs/design/agentic-project-intake.md`, „The
 * information need"): which profile keys the project still needs, computed
 * from the wizard's questions, their conditions and the profile as it stands.
 * Pure. The agent's `intake_needs` tool returns its result.
 */

import type { ProjectIntakeDefinition } from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import type { IntakeMode, Need } from './types'

export interface ComputeNeedsOptions {
  mode: IntakeMode
  /** Values a person dismissed, per key; never suggested again. */
  dismissed: ReadonlyArray<{ key: string; value: ProjectPrimitiveValue }>
  /** Keys a person marked „nicht bekannt"; not a need. Defaults to the profile's `unknowns`. */
  unknownKeys?: ReadonlyArray<string>
}

// TODO(slice 2, needs and derivation): implement and spec. Signature frozen by slice 0.
export function computeNeeds(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
  options: ComputeNeedsOptions
): Need[] {
  void profile
  void definition
  void options
  throw new Error('not implemented')
}
