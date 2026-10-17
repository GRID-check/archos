'use client'

/**
 * Why an upload row is held (ADR-0086), for every surface that lists this
 * session's uploads: the tray, the drop zone, the chat's file list.
 *
 * Two kinds of row are held. A file the content check held back carries its
 * verdict (`quarantined:{…}`), which reads as its findings. A file refused
 * because the document it would replace is held (`TrackedFile.replacesHeld`)
 * has no verdict of its own: its sentence says what it waits for. Handing that
 * row to the findings would claim the reason „is not stored", which is not what
 * happened.
 */

import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import type { TrackedFile } from '../types'
import { QuarantineFindings } from './quarantine-findings'

export interface HeldUploadReasonProps {
  errorMessage: string | null | undefined
  replacesHeld?: TrackedFile['replacesHeld']
  /** Leave out the findings' sentence that explains holding back, where the surface says it already. */
  withoutSentence?: boolean
  className?: string
  testId: string
}

export function HeldUploadReason({
  errorMessage,
  replacesHeld,
  withoutSentence,
  className,
  testId,
}: HeldUploadReasonProps): JSX.Element {
  if (replacesHeld) {
    return (
      <p className={cn('text-muted-foreground text-xs leading-snug', className)} data-testid={`${testId}-replaces`}>
        {errorMessage}
      </p>
    )
  }
  return (
    <QuarantineFindings
      errorMessage={errorMessage}
      withoutSentence={withoutSentence}
      className={className}
      testId={testId}
    />
  )
}
