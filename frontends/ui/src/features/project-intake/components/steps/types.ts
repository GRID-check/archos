/**
 * The contract between the setup page's frame and its five steps (ticket 26,
 * `docs/design/project-setup-five-steps.md`).
 *
 * The frame (`intake-setup-view.tsx`) owns the stepper, which step is shown,
 * the drop anywhere on the page, the reading's status line and the upload
 * machinery. Each step is one organism in this folder that takes
 * {@link SetupStepProps} (plus what only it needs) and renders its own body and
 * its own way on: it calls `onNext` when the person is done with it. A step
 * never reaches for another step's state.
 */

import type { ReactNode } from 'react'
import type { DropInfo } from '@/features/documents/hooks/use-file-drag-drop'
import type { IntakeDecision, IntakeView } from '@/lib/project-intake/types'

/** The five steps, in the order a person goes through them. */
export const SETUP_STEP_IDS = ['project', 'filing', 'reading', 'questions', 'profile'] as const
export type SetupStepId = (typeof SETUP_STEP_IDS)[number]

export function isSetupStepId(value: unknown): value is SetupStepId {
  return typeof value === 'string' && (SETUP_STEP_IDS as readonly string[]).includes(value)
}

/** What every step is given by the frame. */
export interface SetupStepProps {
  view: IntakeView
  projectId: string
  /** A call is in flight: controls wait (`BusyButton blocked`), never disable. */
  busy: boolean
  /** The reader may decide (`view.canDecide`) and the setup is not finished. */
  canDecide: boolean
  /** Whether the project takes documents (a closed or finished one does not). */
  canUpload: boolean
  uploading: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
  /** File documents in the project's root, through the project's own upload. */
  onFiles: (files: File[], info?: DropInfo) => void
  /** Start a reading of what is not read yet. */
  onReread: () => void | Promise<void>
  /** Go to the next step; absent on the last. */
  onNext?: () => void
  /** Go to a named step (a link from one step's content to another). */
  onGoTo: (step: SetupStepId) => void
}

/** What the frame shows in the stepper for a step: its short note („23 gelesen", „3 offen"). */
export interface SetupStepSummary {
  id: SetupStepId
  /** Short and countable, or undefined when there is nothing to say. */
  note?: string
  /** Whether the step still asks something of the person. */
  open: boolean
}

/** Slot props for a step's body: a step may hand the frame extra content (the upload tray). */
export interface SetupStepSlots {
  children?: ReactNode
}
