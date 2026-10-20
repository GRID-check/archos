'use client'

import type { JSX } from 'react'
import { ReadingSkeleton } from '../reading-skeleton'
import type { SetupStepProps } from './types'

/**
 * Step 3, Erfassung (stub): the reading in the background, its progress, and
 * leaving while it runs. Owned by the step-3 build.
 */
export function ReadingStep({ view }: SetupStepProps): JSX.Element {
  return <div data-testid="setup-step-reading">{view.status === 'reading' && <ReadingSkeleton />}</div>
}
