'use client'

import type { JSX } from 'react'
import type { SetupStepProps } from './types'

/**
 * Step 1, Projekt (stub): what the create dialog took, and the Beteiligte.
 * Owned by the step-1 build; see `docs/design/project-setup-five-steps.md`.
 */
export function ProjectStep(_props: SetupStepProps): JSX.Element {
  return <div data-testid="setup-step-project" />
}
