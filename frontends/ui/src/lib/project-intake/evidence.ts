/**
 * Evidence from a document, as the profile stores it and as a person reads it
 * (ADR-0111). Two readings of the project's documents write it: the closing
 * extraction (`project-experience/service.ts`) and the intake
 * (`project-intake/service.ts`). One place builds it, so both mask a quote the
 * same way and both word the `reason` the same way.
 *
 * The profile is read by every member and rides every turn, and a Bescheid's
 * quote can name its addressee, so a quote is masked against the office's
 * „Sensible Daten" policy (ADR-0086) before it is stored.
 */

import 'server-only'
import { maskChatText } from '@/lib/upload-screening/service'
import {
  MAX_EVIDENCE_QUOTE_LENGTH,
  type DocumentEvidence,
} from '@/lib/project-profile/evidence-schema'

/** Where a value was read, as a reading reports it: the page is 1-based, null when the document has none. */
export interface RawDocumentEvidence {
  fileName: string
  page: number | null
  quote: string
}

/** Whose masking policy applies: the organization's, which the project belongs to. */
export interface EvidencePolicy {
  organizationId: string
}

/**
 * The evidence with its quote masked and cut to what the profile keeps. Masked
 * first and cut second, so a cut can never leave half an IBAN behind. The file
 * name is the one the project's files list shows and is kept as it is: the
 * upload gate already screened it, and a reader needs it to find the page.
 */
export async function documentEvidence(
  raw: RawDocumentEvidence,
  policy: EvidencePolicy
): Promise<DocumentEvidence> {
  const masked = (await maskChatText(policy.organizationId, raw.quote)).text.trim()
  return {
    kind: 'document',
    fileName: raw.fileName,
    page: raw.page,
    quote:
      masked.length > MAX_EVIDENCE_QUOTE_LENGTH
        ? `${masked.slice(0, MAX_EVIDENCE_QUOTE_LENGTH - 1)}…`
        : masked,
  }
}

/**
 * The human reason a suggestion carries beside its structured evidence:
 * `Datei, S. n: „quote"`, the page omitted when the document has none.
 */
export function reasonFromEvidence(
  evidence: Pick<DocumentEvidence, 'fileName' | 'page' | 'quote'>
): string {
  const where = evidence.page ? `${evidence.fileName}, S. ${evidence.page}` : evidence.fileName
  return `${where}: „${evidence.quote}"`
}
