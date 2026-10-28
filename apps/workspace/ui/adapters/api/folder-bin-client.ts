/**
 * The bin client (ADR-0088): a project's deleted folders and binned documents,
 * restoring one, purging one now, and the organization's setting for content
 * derived from deleted folders. The listing's shape is the route's own
 * (`@/lib/projects/folder-bin-wire`).
 */

import { z } from 'zod'
import {
  BIN_PAGE_MAX,
  binListingSchema,
  documentRestoreResultSchema,
  type BinEntryWire,
  type BinListingWire,
  type DocumentRestoreResult,
} from '@/lib/projects/folder-bin-wire'
import { ApiRequestError } from './api-error'

export type FolderBinEntry = BinEntryWire
export type FolderBinListing = BinListingWire

const RestoreSchema = z.object({
  restoredTo: z.enum(['original', 'root']),
  folders: z.number(),
  documents: z.number(),
})

export type RestoreFolderResult = z.infer<typeof RestoreSchema>

const CountsSchema = z.object({
  documents: z.number(),
  folders: z.number(),
  memoryNotes: z.number(),
  answers: z.number(),
  conversations: z.number(),
  reports: z.number(),
  tracesErased: z.number(),
})

const PurgeSchema = z.object({ status: z.string(), counts: CountsSchema })

export const DELETED_FOLDER_CONTENT_POLICIES = ['unchanged', 'project', 'admins', 'remove'] as const
export type DeletedFolderContentPolicy = (typeof DELETED_FOLDER_CONTENT_POLICIES)[number]

const PolicySchema = z.object({ policy: z.enum(DELETED_FOLDER_CONTENT_POLICIES) })

/** A refusal, with the machine-readable reason when the server gave one. */
export class FolderBinRequestError extends ApiRequestError {
  constructor(
    message: string,
    status: number,
    readonly reason: string | null
  ) {
    super(message, status)
  }
}

async function request<T>(url: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const record = (body ?? {}) as { error?: unknown; details?: { reason?: unknown } }
    const message = typeof record.error === 'string' ? record.error : `Request failed: ${response.status}`
    const reason = typeof record.details?.reason === 'string' ? record.details.reason : null
    throw new FolderBinRequestError(message, response.status, reason)
  }
  return schema.parse(await response.json())
}

const project = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}`

/** One page of the bin, as large as the route serves; `cursor` continues after the page before. */
export function listFolderBin(projectId: string, cursor?: string): Promise<FolderBinListing> {
  const query = new URLSearchParams({ limit: String(BIN_PAGE_MAX), ...(cursor ? { cursor } : {}) })
  return request(`${project(projectId)}/bin?${query.toString()}`, { method: 'GET' }, binListingSchema)
}

/** Take a document that went to the bin on its own back out, to the folder it came from. */
export function restoreDocument(documentId: string): Promise<DocumentRestoreResult> {
  return request(`/api/documents/${encodeURIComponent(documentId)}/restore`, { method: 'POST' }, documentRestoreResultSchema)
}

export function restoreFolder(projectId: string, folderId: string): Promise<RestoreFolderResult> {
  return request(`${project(projectId)}/bin/${encodeURIComponent(folderId)}/restore`, { method: 'POST' }, RestoreSchema)
}

export function purgeFolderNow(projectId: string, folderId: string): Promise<z.infer<typeof PurgeSchema>> {
  return request(`${project(projectId)}/bin/${encodeURIComponent(folderId)}`, { method: 'DELETE' }, PurgeSchema)
}

export async function getDeletedFolderContentPolicy(): Promise<DeletedFolderContentPolicy> {
  return (await request('/api/organization/deleted-folder-content', { method: 'GET' }, PolicySchema)).policy
}

export async function saveDeletedFolderContentPolicy(policy: DeletedFolderContentPolicy): Promise<DeletedFolderContentPolicy> {
  return (
    await request(
      '/api/organization/deleted-folder-content',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy }) },
      PolicySchema
    )
  ).policy
}
