/**
 * Why the server refused a move, a create or a rename on a shelf, read from
 * its answer, so the reader is told the reason and not „konnte nicht
 * verschoben werden. Bitte versuchen Sie es erneut": every one of these fails
 * the same way again, and asking to retry it is wrong.
 *
 * Only what the answer says by status or by a machine-readable reason
 * (`details.code`, `details.reason`): its English `error` text is never matched.
 */

import {
  FOLDER_DELETED_REASON,
  FOLDER_NAME_TAKEN_REASON,
  IFC_IN_RESTRICTED_FOLDER,
} from '@/lib/projects/folder-bin-codes'

export type ShelfRefusal =
  /** One end may only be read (ADR-0088): the folder it left or the one it was going to. */
  | 'readOnly'
  /** A sibling of the same name already lives where the folder would land. */
  | 'nameTaken'
  /** An IFC model bound for a folder that restricts reading (ADR-0087). */
  | 'ifcRestricted'
  /** The folder went to the Papierkorb between the drag and the drop. */
  | 'gone'

interface RefusalBody {
  code?: string
  details?: { code?: string; reason?: string }
}

/** The refusal an answer states, or null for a failure with no stated reason (a network error, a 500). */
export async function shelfRefusalOf(response: Response): Promise<ShelfRefusal | null> {
  if (response.status === 403) return 'readOnly'
  // Whatever the body is (none, not JSON, a proxy's HTML page), it states no reason.
  const body = (await Promise.resolve()
    .then(() => response.json())
    .catch(() => ({}))) as RefusalBody
  const { code, reason } = body.details ?? {}
  if (code === IFC_IN_RESTRICTED_FOLDER) return 'ifcRestricted'
  if (reason === FOLDER_NAME_TAKEN_REASON) return 'nameTaken'
  if (reason === FOLDER_DELETED_REASON) return 'gone'
  return null
}

/** A failed request, carrying the refusal its answer stated. */
export class ShelfRequestError extends Error {
  constructor(readonly refusal: ShelfRefusal | null, status: number) {
    super(`Shelf request failed (${status})`)
  }
}

/** Throw the refusal of a failed answer; nothing for a good one. */
export async function throwUnlessOk(response: Response): Promise<void> {
  if (response.ok) return
  throw new ShelfRequestError(await shelfRefusalOf(response), response.status)
}

/** The refusal behind a caught error, or null when it stated none. */
export const refusalOf = (error: unknown): ShelfRefusal | null =>
  error instanceof ShelfRequestError ? error.refusal : null
