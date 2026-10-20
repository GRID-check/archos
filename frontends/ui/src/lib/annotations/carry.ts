/**
 * Which document a mark goes on to when it is carried to the current Fassung
 * (`carryToCurrent`, `./service.ts`).
 *
 * Under its own name a document's current Fassung is its published version,
 * and a mark moves there in place. When a person confirmed that ANOTHER
 * document replaces it (Index B filed again as Index C, `supersededBy` in
 * `lib/documents/revision-links.ts`), the current Fassung is that document's, and if C
 * was replaced in turn, the end of the chain. The chain is read the way every
 * Fassung fact reaches a person (`loadRevisionLinks`): only through documents
 * the reader may open, so a mark never goes on to a document its carrier could
 * not see, and a link into a closed folder ends the walk where the reader's
 * view of it ends.
 */

import 'server-only'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { REVISION_MAX_HISTORY } from '@/lib/documents/revision-links'
import { loadRevisionLinks } from '@/lib/documents/revision-links-loader'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'

/** The document that replaces `doc` now, at the end of its chain of confirmed links; null when nothing replaces it. */
export async function replacingDocumentOf(session: AuthorizedSession, doc: Document): Promise<Document | null> {
  const seen = new Set([doc.id])
  let current = doc
  for (let step = 0; step < REVISION_MAX_HISTORY; step += 1) {
    const facts = await loadRevisionLinks(session, [current], await shelfReaderFor(session, current))
    const next = facts.get(current.id)?.supersededBy ?? null
    if (!next || seen.has(next.id)) break
    seen.add(next.id)
    // The shelf may show a link the reader still cannot open (a closed folder): the walk ends at the last one they can.
    const opened = await getAccessibleDocument(session, next.id, 'read').catch((error: unknown) => {
      if (error instanceof NotFoundError || error instanceof ForbiddenError) return null
      throw error
    })
    if (!opened) break
    current = opened
  }
  return current.id === doc.id ? null : current
}
