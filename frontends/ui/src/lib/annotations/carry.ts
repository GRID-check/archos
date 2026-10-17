/**
 * Which document a mark goes on to when it is carried to the current Fassung
 * (`carryToCurrent`, `./service.ts`).
 *
 * Under its own name a document's current Fassung is its published version,
 * and a mark moves there in place. When a person confirmed that ANOTHER
 * document replaces it (Index B filed again as Index C, `supersededBy` in
 * `lib/documents/fassung.ts`), the current Fassung is that document's, and if C
 * was replaced in turn, the end of the chain. The chain is read the way every
 * Fassung fact reaches a person (`loadFassungFacts`): only through documents
 * the reader may open, so a mark never goes on to a document its carrier could
 * not see, and a link into a closed folder ends the walk where the reader's
 * view of it ends.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { FASSUNG_MAX_HISTORY } from '@/lib/documents/fassung'
import { loadFassungFacts } from '@/lib/documents/fassung-facts'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'

/** The document that replaces `doc` now, at the end of its chain of confirmed links; null when nothing replaces it. */
export async function replacingDocumentOf(session: AuthorizedSession, doc: Document): Promise<Document | null> {
  const seen = new Set([doc.id])
  let current = doc
  for (let step = 0; step < FASSUNG_MAX_HISTORY; step += 1) {
    const facts = await loadFassungFacts(session, [current], await shelfReaderFor(session, current))
    const next = facts.get(current.id)?.supersededBy ?? null
    if (!next || seen.has(next.id)) break
    seen.add(next.id)
    current = await getAccessibleDocument(session, next.id, 'read')
  }
  return current.id === doc.id ? null : current
}
