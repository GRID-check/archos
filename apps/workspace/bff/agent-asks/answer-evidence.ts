/**
 * The evidence of Piloti's answer, for the agent that asked (ADR-0124).
 *
 * Read from what the answer's message already stores, never recomputed:
 * `metadata.citations` (the sources the answer cited, ADR-0125's per-sentence
 * provenance rides beside it) and `metadata.provenance.answerConfidence`.
 * Nothing is added to the message, so nothing here is more than the person
 * would see on the same answer in their own thread.
 *
 * A source's link is the UI's own citation link (`?cite=` on the conversation,
 * `features/chat/lib/citations/deep-link.ts`): it opens the thread at that
 * answer's citation, at the cited page. The conversation is the asker's own
 * private thread, so only the asker can follow it.
 *
 * Pure: no database, no session.
 */

import { buildCitationModel } from '@/features/chat/lib/citations/build'
import { CITATION_PARAM, encodeCitationLink } from '@/features/chat/lib/citations/deep-link'
import { citedLoci, isHttpUrl } from '@/features/chat/lib/citations/model'
import { decodeCitations } from '@/features/chat/lib/citations/persistence'
import { describeResource } from '@/lib/sharing/registry'
import { sanitizeProvenance } from '@/lib/conversations/message-provenance'
import type { AskAnswerEvidence } from './ask-wire'

interface EvidenceMessage {
  metadata: unknown
  createdAt: Date | string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The conversation's link in the app: absolute where the deployment pins its origin. */
function threadPath(conversationId: string, projectId: string | null, origin: string | null): string {
  const path = describeResource('conversation').deepLink(conversationId, { projectId: projectId ?? undefined })
  return origin ? `${origin}${path}` : path
}

function sourcesOf(
  message: EvidenceMessage,
  thread: { conversationId: string; projectId: string | null; origin: string | null },
): NonNullable<AskAnswerEvidence['sources']> {
  const metadata = isRecord(message.metadata) ? message.metadata : {}
  const citations = decodeCitations(metadata.citations, new Date(message.createdAt))
  if (!citations) return []
  const base = threadPath(thread.conversationId, thread.projectId, thread.origin)
  const sources: NonNullable<AskAnswerEvidence['sources']> = []
  for (const document of buildCitationModel({ citations })) {
    const loci = citedLoci(document)
    if (loci.length === 0) continue
    // A web or RIS source links out; a document opens in the thread at its page.
    const outbound = document.url && isHttpUrl(document.url) ? document.url : null
    const pages = new Set<number | undefined>()
    for (const locus of loci) {
      if (pages.has(locus.page)) continue
      pages.add(locus.page)
      sources.push({
        documentId: document.id,
        name: document.title,
        ...(locus.page !== undefined && { page: locus.page }),
        url: outbound ?? `${base}&${CITATION_PARAM}=${encodeCitationLink({ document, locus })}`,
      })
    }
  }
  return sources
}

function confidenceOf(message: EvidenceMessage): AskAnswerEvidence['confidence'] {
  const metadata = isRecord(message.metadata) ? message.metadata : {}
  const provenance = sanitizeProvenance(metadata.provenance)
  if (!provenance?.answerConfidence) return undefined
  return {
    level: provenance.answerConfidence,
    ...(provenance.answerConfidenceReason && { reason: provenance.answerConfidenceReason }),
    ...(provenance.answerConfidenceCappedReason && { cappedReason: provenance.answerConfidenceCappedReason }),
    ...(provenance.lookupFoundNothing && { lookupFoundNothing: true as const }),
  }
}

/** The sources and confidence the answer's message stores; a key is absent where the message has none. */
export function answerEvidence(
  message: EvidenceMessage,
  thread: { conversationId: string; projectId: string | null; origin?: string | null },
): AskAnswerEvidence {
  const sources = sourcesOf(message, { ...thread, origin: thread.origin ?? null })
  const confidence = confidenceOf(message)
  return { ...(sources.length > 0 && { sources }), ...(confidence && { confidence }) }
}
