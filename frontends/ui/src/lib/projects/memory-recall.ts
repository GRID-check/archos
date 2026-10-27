/**
 * The memory digest's recall window: the one read `buildProjectMemoryDigest`
 * ranks over (`memory-service.ts`), and what decided its cost.
 */

import { desc, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projectMemory } from '@/lib/db/schema/project-memory'
import { cosineSimilaritySql, type EmbeddedNote } from '@/lib/knowledge/embeddings'

/**
 * Candidates considered before ranking. Bounded like every list here; past
 * this the tail is by definition the least recently touched.
 */
export const RECALL_CANDIDATE_LIMIT = 200

/** What decided one digest build's cost. */
export interface DigestTiming {
  /**
   * The dense channel: no question to embed, skipped (nothing in scope carries
   * a vector to compare with), ranked, or unavailable (the embed failed or
   * timed out, and recall stayed lexical).
   */
  dense?: 'no-query' | 'skipped' | 'ranked' | 'unavailable'
}

/**
 * The recall window: active memory in `scope`, by similarity to `embedded` when
 * there is one and by recency after it. `hasEmbedding` says whether a row
 * carries a vector at all without shipping it: cosine is computed in SQL, so a
 * 3072-dimension vector per row never crosses the wire.
 */
export function selectRecallCandidates(scope: SQL | undefined, embedded: EmbeddedNote | null) {
  const relevanceColumn = embedded
    ? cosineSimilaritySql(projectMemory.embedding, embedded.vector)
    : sql<number | null>`null::double precision`
  return getDb()
    .select({
      id: projectMemory.id,
      scope: projectMemory.scope,
      kind: projectMemory.kind,
      content: projectMemory.content,
      confidence: projectMemory.confidence,
      verification: projectMemory.verification,
      restrictedFolderIds: projectMemory.restrictedFolderIds,
      pinned: projectMemory.pinned,
      salience: projectMemory.salience,
      lastReferencedAt: projectMemory.lastReferencedAt,
      recallCount: projectMemory.recallCount,
      relevance: relevanceColumn,
      // Only compare vectors from the model that produced them: a same-size
      // vector from another embedder is noise wearing the right shape.
      embeddingModel: projectMemory.embeddingModel,
      hasEmbedding: sql<boolean>`(${projectMemory.embedding} is not null)`,
    })
    .from(projectMemory)
    .where(scope)
    // The window is the whole quality mechanism's ceiling: everything below
    // (dedup, decay, hybrid fusion) runs over these rows only. Recency was the
    // only order it had, so past two hundred notes a relevant old one could
    // not be recalled at all. With a query, the database ranks by similarity
    // first and recency breaks ties; without one, recency is still the order.
    .orderBy(...(embedded ? [sql`${relevanceColumn} desc nulls last`] : []), desc(projectMemory.updatedAt))
    .limit(RECALL_CANDIDATE_LIMIT)
}
