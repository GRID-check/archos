/**
 * What differs between the kinds of proposed change (ADR-0105): the payload's
 * schema, who may decide, what is refused when it is proposed, the inbox line,
 * and which applier runs. `./service` owns the lifecycle, the same for every
 * kind, and asks here for the rest.
 *
 * One gate per kind, and it is the applier's own: a decider who passes it is
 * not then refused by the service that writes.
 */

import 'server-only'
import { UnprocessableError } from '@/lib/api/errors'
import { DOCUMENT_WRITE_PERMISSIONS } from '@/lib/authz/folder-access-rule'
import type { ProjectPermission } from '@/lib/authz/projects'
import { validateProfilePatchVocabulary } from '@/lib/project-profile/intake-definition'
import { MEMORY_WRITE_PERMISSIONS } from '@/lib/projects/service'
import { applyMemory, applyProjectProfile, noteLabel, type ApplyContext } from './appliers'
import { applyFileOperations, operationLabel, REQUIRED_FIELDS } from './executors'
import {
  fileOperationPayloadSchema,
  memoryPayloadSchema,
  projectProfilePayloadSchema,
  type FileOperationPayload,
  type MemoryPayload,
  type ProjectProfilePayload,
  type ProposalNoticeVariant,
  type ProposedChangeKind,
  type ProposedChangeResult,
} from './types'

/** A payload with its kind, so every switch below is exhaustive and typed. */
export type KindPayload =
  | { kind: 'file_operation'; payload: FileOperationPayload }
  | { kind: 'memory'; payload: MemoryPayload }
  | { kind: 'project_profile'; payload: ProjectProfilePayload }

/** Parse a stored or requested payload by its kind; throws on one that does not parse. */
export function parseKindPayload(kind: ProposedChangeKind, payload: unknown): KindPayload {
  switch (kind) {
    case 'file_operation':
      return { kind, payload: fileOperationPayloadSchema.parse(payload) }
    case 'memory':
      return { kind, payload: memoryPayloadSchema.parse(payload) }
    case 'project_profile':
      return { kind, payload: projectProfilePayloadSchema.parse(payload) }
  }
}

/**
 * The right that decides each kind, any of the list.
 * - `file_operation`: the documents' write (`moveDocumentToFolder` and its siblings).
 * - `memory`: `addProjectMemoryItem`'s gate. An organization note needs no more
 *   (any member writes the office's memory), so the project's gate is the one.
 * - `project_profile`: `PROFILE_WRITE` in `lib/project-profile/profile-service.ts`,
 *   the same two rights.
 */
export const DECIDE_PERMISSIONS: Record<ProposedChangeKind, readonly ProjectPermission[]> = {
  file_operation: DOCUMENT_WRITE_PERMISSIONS,
  memory: MEMORY_WRITE_PERMISSIONS,
  project_profile: MEMORY_WRITE_PERMISSIONS,
}

/** Every file item carries the fields its verb needs, or the proposal is refused (422). */
function requireItemFields(payload: FileOperationPayload): void {
  const required = REQUIRED_FIELDS[payload.operation]
  payload.operations.forEach((item, index) => {
    const missing = required.filter((field) => {
      const value = item[field]
      return typeof value !== 'string' || value.trim().length === 0
    })
    if (missing.length > 0) {
      throw new UnprocessableError(`Item ${index + 1} of a ${payload.operation} lacks ${missing.join(', ')}`, {
        reason: 'proposal-item-incomplete',
        index,
        missing,
      })
    }
  })
}

/** A profile value outside the intake vocabulary is refused when proposed, not first when accepted (422). */
function requireProfileVocabulary(payload: ProjectProfilePayload): void {
  try {
    validateProfilePatchVocabulary(payload.patch)
  } catch (error) {
    throw new UnprocessableError(error instanceof Error ? error.message : 'Invalid project profile patch', {
      reason: 'proposal-profile-vocabulary',
    })
  }
}

/** Refuse, when it is proposed, what could only fail when it is applied. */
export function requireProposable(typed: KindPayload): void {
  if (typed.kind === 'file_operation') requireItemFields(typed.payload)
  if (typed.kind === 'project_profile') requireProfileVocabulary(typed.payload)
}

/** How many names the inbox row lists before it counts the rest. */
const SUMMARY_NAMES = 2

/**
 * One line naming what a proposal touches, for the inbox row. Files: the first
 * names, then how many more. A note: its first words. A profile change: its
 * title. No verb, so it needs no language.
 */
export function summaryOf(typed: KindPayload): string {
  switch (typed.kind) {
    case 'file_operation': {
      const { operation, operations } = typed.payload
      const names = operations.map((item) => operationLabel(operation, item)).filter(Boolean)
      const shown = names.slice(0, SUMMARY_NAMES).join(', ')
      return names.length > SUMMARY_NAMES ? `${shown} +${names.length - SUMMARY_NAMES}` : shown
    }
    case 'memory':
      return noteLabel(typed.payload.content)
    case 'project_profile':
      return typed.payload.title
  }
}

/** What the proposal changes, as the inbox row words it: a file operation by its verb, the rest by kind. */
export function noticeVariantOf(typed: KindPayload): ProposalNoticeVariant {
  return typed.kind === 'file_operation' ? typed.payload.operation : typed.kind
}

/** Run the kind's applier. Item outcomes are results; a refusal of the decider is thrown. */
export function applyKind(typed: KindPayload, context: ApplyContext): Promise<ProposedChangeResult[]> {
  switch (typed.kind) {
    case 'file_operation':
      return applyFileOperations(typed.payload.operation, typed.payload.operations, context)
    case 'memory':
      return applyMemory(typed.payload, context)
    case 'project_profile':
      return applyProjectProfile(typed.payload, context)
  }
}
