/**
 * What the Ablage step reads and writes, as one typed seam: the project's
 * sensitive-data list (`/api/projects/[id]/upload-screening`), its folders
 * (`/api/projects/[id]/folders`) and, to restrict a folder before its files
 * arrive, the folder upload's own resolver (`…/folders/ensure`), which creates
 * a folder exactly as the upload would and answers it if it exists.
 *
 * The step takes the real one by default; the `/dev` preview and the specs
 * bring their own.
 */

import { z } from 'zod'
import { ApiRequestError } from '@/adapters/api/api-error'
import {
  getProjectUploadScreening,
  saveProjectUploadScreening,
  type ProjectUploadScreeningState,
} from '@/adapters/api/project-upload-screening-client'
import type { FolderItem } from '@/features/documents/file-types'
import type { ProjectScreeningOverride } from '@/lib/upload-screening/project-policy'

export interface FilingSetupClient {
  loadScreening: (projectId: string) => Promise<ProjectUploadScreeningState>
  saveScreening: (projectId: string, override: ProjectScreeningOverride) => Promise<ProjectUploadScreeningState>
  listFolders: (projectId: string) => Promise<FolderItem[]>
  /** The project folder at this path from the project's top, created when it is missing. */
  ensureFolder: (projectId: string, path: string) => Promise<FolderItem>
}

const FolderSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  description: z.string().nullable().optional(),
  ownAccess: z.object({ everyoneReads: z.boolean() }).nullable().optional(),
  access: z.enum(['read', 'write']).optional(),
})

const FoldersSchema = z.object({ folders: z.array(FolderSchema) })
const EnsuredSchema = z.object({ folders: z.array(FolderSchema), folderIdByPath: z.record(z.string(), z.string()) })

const foldersUrl = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/folders`

async function failed(response: Response, what: string): Promise<ApiRequestError> {
  return new ApiRequestError(`${what}: ${response.status}`, response.status)
}

export const filingSetupClient: FilingSetupClient = {
  loadScreening: getProjectUploadScreening,
  saveScreening: saveProjectUploadScreening,
  async listFolders(projectId) {
    const response = await fetch(foldersUrl(projectId))
    if (!response.ok) throw await failed(response, 'Failed to load the folders')
    return FoldersSchema.parse(await response.json()).folders
  },
  async ensureFolder(projectId, path) {
    const response = await fetch(`${foldersUrl(projectId)}/ensure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: null, paths: [path] }),
    })
    if (!response.ok) throw await failed(response, 'Failed to create the folder')
    const { folders, folderIdByPath } = EnsuredSchema.parse(await response.json())
    const id = folderIdByPath[path]
    if (!id) throw new ApiRequestError('The folder was not answered', 500)
    // The resolver answers the folders it created; one that was there already
    // is read from the listing, with its access as this reader sees it.
    const folder =
      folders.find((candidate) => candidate.id === id) ??
      (await filingSetupClient.listFolders(projectId)).find((candidate) => candidate.id === id)
    if (!folder) throw new ApiRequestError('The folder was not answered', 500)
    return folder
  },
}
