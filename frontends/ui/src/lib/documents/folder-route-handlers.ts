/**
 * The route handlers for a shelf's folders — written ONCE for a project's
 * Dateien (`/api/projects/[id]/folders*`) and the org-wide Archiv
 * (`/api/office-shelf/folders*`), because the two are the same routes (ADR-0078).
 *
 * What differs per shelf is passed in: the service call (which carries its own
 * authorization — `@/lib/projects/folder-service`, `@/lib/office-shelf/folder-service`).
 * What does not differ — the request schemas and their limits, the mapping of a
 * refused request to a 400, the response shapes — lives here, so the browser can
 * share one client and one row mapper.
 *
 * Handlers, not routes: each `route.ts` still calls `apiRoute` itself and
 * declares its own `authz`, which is what `authz-coverage.spec.ts` reads and
 * what a reviewer sees next to the verb.
 */

import { parseJsonBody, type ApiContext } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { createFolderSchema, ensureFoldersSchema, updateFolderSchema } from './folder-wire'
import { FOLDER_NAME_TAKEN_REASON } from '@/lib/projects/folder-bin-codes'
import { FOLDER_NAME_TAKEN, type DeleteFolderResult, type FolderRow } from './shelf-folders'

type Outcome<T> = ({ ok: true } & T) | { ok: false; error: string }

/** A service answer that is either its value or a message the caller's request earned. */
function unwrap<T extends object>(outcome: Outcome<T>): T {
  if (outcome.ok) return outcome
  // A taken name is the one refusal the browser words differently („„Statik"
  // gibt es dort schon"), so it carries its reason rather than only English.
  const details = outcome.error === FOLDER_NAME_TAKEN ? { reason: FOLDER_NAME_TAKEN_REASON } : undefined
  throw new BadRequestError(outcome.error, details)
}

/** `GET …/folders` → `{ folders }`. */
export function listFoldersHandler<P>(list: (params: P, session: AuthorizedSession) => Promise<FolderRow[]>) {
  return async ({ session, params }: ApiContext<P>): Promise<unknown> => ({ folders: await list(params, session) })
}

/** `POST …/folders` `{ name, parentId? }` → `{ folder }`. */
export function createFolderHandler<P>(
  create: (
    params: P,
    session: AuthorizedSession,
    input: { name: string; parentId: string | null },
  ) => Promise<Outcome<{ folder: FolderRow }>>,
) {
  return async ({ session, params, request }: ApiContext<P>): Promise<unknown> => {
    const { name, parentId } = await parseJsonBody(request, createFolderSchema)
    const { folder } = unwrap(await create(params, session, { name, parentId: parentId ?? null }))
    return { folder }
  }
}

/** `PATCH …/folders/[folderId]` `{ name?, parentId?, description? }` → `{ folder }`. */
export function updateFolderHandler<P extends { folderId: string }>(
  update: (
    params: P,
    session: AuthorizedSession,
    patch: { name?: string; parentId?: string | null; description?: string | null },
    request: Request,
  ) => Promise<Outcome<{ folder: FolderRow }>>,
) {
  return async ({ session, params, request }: ApiContext<P>): Promise<unknown> => {
    const body = await parseJsonBody(request, updateFolderSchema)
    const { folder } = unwrap(
      await update(params, session, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      }, request),
    )
    return { folder }
  }
}

/**
 * `DELETE …/folders/[folderId]` → `{ documentsMoved, foldersMoved }`.
 *
 * The delete is the one worth reading before changing: `documents.folder_id` is
 * `ON DELETE CASCADE`, so the service re-files the folder's documents and its
 * child folders BEFORE removing the row. Deleting a label must not delete the
 * work that was filed under it.
 *
 * The Archiv's alone. A project folder's delete is the Papierkorb's
 * (`@/lib/projects/folder-bin`, ADR-0088), with its own route body and answer.
 */
export function deleteFolderHandler<P extends { folderId: string }>(
  remove: (params: P, session: AuthorizedSession, request: Request) => Promise<Outcome<{ result: DeleteFolderResult }>>,
) {
  return async ({ session, params, request }: ApiContext<P>): Promise<unknown> =>
    unwrap(await remove(params, session, request)).result
}

/**
 * `POST …/folders/ensure` `{ parentId?, paths }` → `{ folders, folderIdByPath }`.
 *
 * Not the create endpoint with a loop in front of it: create makes ONE folder
 * under ONE parent and refuses a name a sibling already has — right for a person
 * typing into the New-folder popover, wrong for a folder upload, where "it
 * already exists" is the common case and the desired outcome. Driving a
 * 40-directory tree through it from the browser would also be 40 sequential
 * round trips before the first byte of the first file moved.
 */
export function ensureFoldersHandler<P>(
  ensure: (
    params: P,
    session: AuthorizedSession,
    input: { parentId: string | null; paths: string[] },
  ) => Promise<Outcome<{ folders: FolderRow[]; folderIdByPath: Record<string, string> }>>,
) {
  return async ({ session, params, request }: ApiContext<P>): Promise<unknown> => {
    const { parentId, paths } = await parseJsonBody(request, ensureFoldersSchema)
    const { folders, folderIdByPath } = unwrap(
      await ensure(params, session, { parentId: parentId ?? null, paths }),
    )
    return { folders, folderIdByPath }
  }
}
