/**
 * Document roles API client
 *
 * Typed fetch client for the bindings that say which document a project uses
 * for a role, such as its Bebauungsplan (`/api/projects/[id]/document-roles…`).
 * Same-origin BFF routes. The role vocabulary is the library's own
 * (`lib/project-profile/document-roles.ts`).
 *
 * A refused bind throws {@link DocumentRoleRequestError} with the envelope kept
 * as `body`. Every other refusal throws {@link ApiRequestError} with the status.
 */

import type { DocumentRole } from '@/lib/project-profile/document-roles'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

/** One document bound to one role, as the project lists it. */
export interface RoleBinding {
  id: string
  documentId: string
  role: DocumentRole
  scopeInstanceId: string | null
  confidence: 'declared' | 'suggested'
  filename: string
  displayName: string | null
}

/** The document to bind to a role, and the building it belongs to if the role is per building. */
export interface RoleBindingInput {
  documentId: string
  role: DocumentRole
  scopeInstanceId: string | null
}

/** A refused bind: the status, and the envelope as the server sent it (or null when it sent none). */
export class DocumentRoleRequestError extends ApiRequestError {
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`Failed to bind the document role: ${status}`, status)
    this.name = 'DocumentRoleRequestError'
    this.body = body
  }
}

const rolesPath = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/document-roles`

// ============================================================
// Reads
// ============================================================

/** Every binding the project holds. A body without a list reads as none. */
export const listDocumentRoles = async (projectId: string): Promise<RoleBinding[]> => {
  const response = await fetch(rolesPath(projectId))
  if (!response.ok) throw new ApiRequestError(`Failed to list document roles: ${response.status}`, response.status)
  const body: unknown = await response.json().catch(() => null)
  if (!body || typeof body !== 'object') return []
  const roles = (body as { roles?: unknown }).roles
  return Array.isArray(roles) ? (roles as RoleBinding[]) : []
}

// ============================================================
// Writes
// ============================================================

/**
 * Bind a document to a role. A single-holder role displaces what held it, and
 * the answer names those bindings so the caller can say which document stopped
 * being the one.
 */
export const bindDocumentRole = async (
  projectId: string,
  binding: RoleBindingInput,
): Promise<{ replaced: RoleBinding[] }> => {
  const response = await fetch(rolesPath(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(binding),
  })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    throw new DocumentRoleRequestError(response.status, body)
  }
  const answer = (await response.json()) as { replaced?: RoleBinding[] }
  return { replaced: answer.replaced ?? [] }
}

/** Remove one binding from the project. */
export const unbindDocumentRole = async (projectId: string, bindingId: string): Promise<void> => {
  const response = await fetch(`${rolesPath(projectId)}/${encodeURIComponent(bindingId)}`, { method: 'DELETE' })
  if (!response.ok) throw new ApiRequestError(`Failed to unbind the document role: ${response.status}`, response.status)
}
