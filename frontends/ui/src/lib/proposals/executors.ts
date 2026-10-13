/**
 * Applying a file operation, on the server, as the deciding person.
 *
 * The port of `features/grid-cards/lib/file-operations.ts`, which ran the same
 * four verbs from the browser against the Files pane's routes. Here each verb
 * calls the SERVICE behind that route, with the deciding person's session,
 * exactly as their own PATCH or POST would:
 *
 * | Verb | Service (route) |
 * |---|---|
 * | move | `moveDocumentToFolder` (`PATCH /api/documents/[id]/folder`) |
 * | rename | `renameDocument` (`PATCH /api/documents/[id]`) |
 * | create_folder | `createProjectFolder` (`POST /api/projects/[id]/folders`) |
 * | assign | `listAssignmentCandidates` + `addResourceAssignment` (`/api/assignments/document/[id]`) |
 *
 * Nothing here decides access: every check, audit event and feature gate is
 * the service's, so a person who could not do it by hand cannot do it by
 * accepting a proposal either.
 *
 * ## Names, not ids
 *
 * A proposal names documents by FILE NAME and folders by PATH, because the
 * agent's inventory has no ids. They are resolved here, with the deciding
 * person's own readers (`resolveProjectDocumentsByName`, the folder listings),
 * when the change is applied. A name that no longer resolves fails its item
 * visibly instead of acting on a stale id.
 *
 * ## Partial failure is reported, never rounded off
 *
 * Items run IN ORDER and each one's outcome is kept; a failure does not stop
 * the rest (the items of one proposal are independent: four files into one
 * folder). {@link applyFileOperations} never throws for an item.
 */

import 'server-only'
import { captureServer } from '@/lib/analytics/posthog-server'
import type { AuthorizedSession } from '@/lib/auth/types'
import { addResourceAssignment, listAssignmentCandidates } from '@/lib/assignments/service'
import { listArchivFolders } from '@/lib/archiv/folder-service'
import { resolveArchivDocumentsByName } from '@/lib/archiv/service'
import { moveDocumentToFolder } from '@/lib/documents/move-to-folder'
import { renameDocument, resolveProjectDocumentsByName } from '@/lib/documents/service'
import type { FolderRow } from '@/lib/documents/shelf-folders'
import { createProjectFolder, listProjectFolders } from '@/lib/projects/folder-service'
import { folderMatchKey } from '@/lib/projects/folders'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import type { FileOperation, FileOperationItem, ProposedChangeResult } from './types'

type Shelf = 'projekt' | 'buero'

export interface ExecutionContext {
  session: AuthorizedSession
  projectId: string
  /** The deciding person's request, for the services' audit trail. */
  request: Request
  /** A shelf's folders, loaded at most once per apply: only the folder verbs need them. */
  folders: (shelf: Shelf) => Promise<FolderRow[]>
}

type Executor = (item: FileOperationItem, context: ExecutionContext) => Promise<void>

/** How a name is compared: NFC, trimmed, case-folded (`documentNameLookupKey`, the server's own match). */
const nameKey = (name: string): string => name.normalize('NFC').trim().toLowerCase()

/** A folder path, keyed for comparison segment by segment. */
const pathKey = (path: string): string =>
  path
    .split('/')
    .map(folderMatchKey)
    .filter((segment) => segment.length > 0)
    .join('/')

const shelfOf = (item: FileOperationItem): Shelf => (item.source === 'buero' ? 'buero' : 'projekt')

/** `null` for the shelf root (an empty path), the folder id, or a throw. */
function folderIdForPath(folders: readonly FolderRow[], path: string | null | undefined): string | null {
  const wanted = pathKey(path ?? '')
  if (!wanted) return null
  const hit = folders.find((folder) => pathKey(folder.path) === wanted)
  if (!hit) throw new Error(`Ordner „${path}“ existiert nicht (mehr)`)
  return hit.id
}

/**
 * The document the item names, on its shelf, as the deciding person sees it.
 * The newest of several same-named rows wins, the rule the browser's index
 * applied (a same-named upload is a re-upload).
 */
async function documentIdFor(item: FileOperationItem, { session, projectId }: ExecutionContext): Promise<string> {
  const name = item.document ?? ''
  const rows =
    shelfOf(item) === 'buero'
      ? await resolveArchivDocumentsByName(session, [name])
      : await resolveProjectDocumentsByName(session, projectId, [name])
  const wanted = nameKey(name)
  const newest = rows
    .filter((row) => nameKey(row.filename) === wanted)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
  if (!newest) throw new Error(`„${name}“ wurde nicht gefunden`)
  return newest.id
}

/**
 * The one project member `member` names, by name or email. The deciding
 * person is a candidate too: the candidate list leaves them out because the
 * picker offers „me“ apart, and a proposal to assign the person who accepts it
 * is still a proposal to assign them.
 */
async function memberFor(item: FileOperationItem, documentId: string, { session }: ExecutionContext): Promise<string> {
  const candidates = await listAssignmentCandidates(session, 'document', documentId)
  const self = (await loadOrganizationDirectory(session.organizationId)).get(session.userId)
  const wanted = (item.member ?? '').trim().toLowerCase()
  const people = self ? [self, ...candidates] : candidates
  const matches = people.filter(
    (person) =>
      (person.name ?? '').trim().toLowerCase() === wanted || (person.email ?? '').trim().toLowerCase() === wanted
  )
  // Nobody, or two people with the same name: the proposal named a person this
  // project cannot identify, and picking one would assign work to the wrong
  // colleague. The item fails and says so.
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `„${item.member}“ ist kein Mitglied dieses Projekts`
        : `„${item.member}“ ist im Projekt mehrfach vergeben`
    )
  }
  return matches[0].userId
}

const EXECUTORS: Record<FileOperation, Executor> = {
  move: async (item, context) => {
    const [documentId, folderId] = await Promise.all([
      documentIdFor(item, context),
      context.folders(shelfOf(item)).then((rows) => folderIdForPath(rows, item.target_folder)),
    ])
    const result = await moveDocumentToFolder({ documentId, folderId }, context.session)
    if (!result.ok) throw new Error(result.error)
  },

  rename: async (item, context) => {
    const documentId = await documentIdFor(item, context)
    await renameDocument(context.session, documentId, item.new_display_name ?? null, context.request)
  },

  create_folder: async (item, context) => {
    const parentId = folderIdForPath(await context.folders('projekt'), item.parent_folder)
    const outcome = await createProjectFolder(
      { projectId: context.projectId, parentId, name: item.folder_name ?? '' },
      context.session
    )
    if (!outcome.ok) throw new Error(outcome.error)
  },

  assign: async (item, context) => {
    const documentId = await documentIdFor(item, context)
    const userId = await memberFor(item, documentId, context)
    await addResourceAssignment(context.session, 'document', documentId, userId, context.request)
    // The route's own event (`task_assigned`, ADR-0100): the act, not the person.
    captureServer({
      event: 'task_assigned',
      distinctId: context.session.userId,
      organizationId: context.session.organizationId,
      properties: { resource_type: 'document' },
    })
  },
}

/** What one item says it will do, for the outcome list. */
export function operationLabel(operation: FileOperation, item: FileOperationItem): string {
  if (operation === 'create_folder') {
    return item.parent_folder ? `${item.parent_folder}/${item.folder_name}` : (item.folder_name ?? '')
  }
  return item.document ?? ''
}

/** The fields each verb needs; a proposal missing one is refused when it is made, not when it is applied. */
export const REQUIRED_FIELDS: Record<FileOperation, ReadonlyArray<keyof FileOperationItem>> = {
  move: ['document'],
  rename: ['document', 'new_display_name'],
  create_folder: ['folder_name'],
  assign: ['document', 'member'],
}

/**
 * Apply every item of one file operation, in order, and report each one.
 * Never throws for an item; an item's failure is its `reason`.
 */
export async function applyFileOperations(
  operation: FileOperation,
  items: readonly FileOperationItem[],
  base: Omit<ExecutionContext, 'folders'>
): Promise<ProposedChangeResult[]> {
  const cache = new Map<Shelf, Promise<FolderRow[]>>()
  const loadFolders = (shelf: Shelf): Promise<FolderRow[]> =>
    shelf === 'buero' ? listArchivFolders(base.session) : listProjectFolders(base.projectId, base.session)
  const context: ExecutionContext = {
    ...base,
    folders: (shelf) => {
      let pending = cache.get(shelf)
      if (!pending) {
        pending = loadFolders(shelf)
        cache.set(shelf, pending)
      }
      return pending
    },
  }
  const execute = EXECUTORS[operation]
  const results: ProposedChangeResult[] = []
  for (const item of items) {
    const label = operationLabel(operation, item)
    try {
      await execute(item, context)
      results.push({ label, ok: true })
    } catch (error) {
      results.push({ label, ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}
