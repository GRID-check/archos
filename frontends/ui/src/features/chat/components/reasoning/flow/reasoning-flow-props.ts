import type { CitationSource } from '../../../types'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import { type CitedDocument } from '../../../lib/citations'
import type { RetrievalLedger } from '@/lib/conversations/message-retrieval-ledger'

export interface ReasoningFlowProps {
  steps: StoredThinkingStep[]
  userQuestion: string
  answerConfidence?: 'low' | 'medium' | 'high'
  citations?: CitationSource[]
  escalationReason?: string
  /**
   * The backend's own account of this turn's retrieval rounds. When a round is
   * in it (matched by `index`), the fan under that round is the LEDGER's docs
   * — each at the page THAT round read, and marked when an earlier round had
   * already shown the file. A round the ledger does not have keeps the
   * filename match, which is what every turn before the ledger had.
   */
  retrievalLedger?: RetrievalLedger
  /** Turn is still streaming — the connectors into the newest row march and the graph keeps growing. */
  live?: boolean
  /**
   * The citation model of these steps and citations, when the caller has built
   * it already (ChatThinking counts its sources from it). Built here otherwise;
   * building it twice per step cost the phone twice.
   */
  sourceCards?: CitedDocument[]
}
