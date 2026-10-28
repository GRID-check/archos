/**
 * `getAccessibleDocument(…, 'write')` as a yes or no, for a caller that only
 * reflects it: the Anmerkungen's controls (`canEdit`, `canAnnotate`), and
 * whether an inbox row may answer a mark (`answerIn`). Beside `./access`
 * rather than in it, so a spec that stubs `getAccessibleDocument` decides this
 * too.
 */

import 'server-only'
import { ApiError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getAccessibleDocument } from './access'

/** Whether this session may change the document now. A refusal (403) or a document it cannot reach (404) is no; anything else throws. */
export async function canWriteDocument(session: AuthorizedSession, documentId: string): Promise<boolean> {
  try {
    await getAccessibleDocument(session, documentId, 'write')
    return true
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return false
    throw error
  }
}
