'use client'

import { useState } from 'react'

/**
 * „3 von 7 erledigt" for one pass through step 4. An answered question leaves
 * the review (the server no longer lists it), so what is done is what this
 * visit saw open and no longer does, plus what the server reports settled
 * (a document request whose keys all hold a value). Pure bookkeeping over
 * ids; the step names its items `question:<key>` and `request:<determinant>`.
 */
export function useRoundProgress(
  open: readonly string[],
  settled: readonly string[]
): { done: number; total: number } {
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set(open))
  const unseen = open.filter((id) => !seen.has(id))
  // Derived state from the previous render (React's documented pattern): an
  // item that appears later, opened by an answer, joins the round.
  if (unseen.length > 0) setSeen(new Set([...seen, ...unseen]))
  const all = new Set([...seen, ...open, ...settled])
  return { done: all.size - new Set(open).size, total: all.size }
}
