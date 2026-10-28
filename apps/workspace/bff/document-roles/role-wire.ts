/**
 * The body of `POST /api/projects/[id]/document-roles`, shared by the route and
 * the MCP catalog (`lib/agent-api/catalog/folders.ts`).
 */

import { z } from 'zod'
import { canonicalDocumentRole, DOCUMENT_ROLES } from '@/lib/project-profile/document-roles'

export const declareDocumentRoleSchema = z.object({
  documentId: z.guid(),
  // Enumerated from the vocabulary rather than restated, so a role added there
  // is accepted here without a second edit — and one removed is rejected.
  role: z.preprocess(canonicalDocumentRole, z.enum(DOCUMENT_ROLES)),
  scopeInstanceId: z.string().min(1).max(64).nullable().optional(),
  // `confidence` and `source` are deliberately NOT accepted from the caller.
  //
  // They are provenance: `suggested` means a classifier proposed this and no
  // human has confirmed it, and the prompt marks such a binding as unbestätigt.
  // Letting the request name them let any `project:documents:write` holder mint
  // a binding that reads as machine-proposed, or launder a real classifier
  // suggestion into a confirmed fact. A human POSTing here IS the confirmation,
  // so the service's defaults (`declared` / `user`) are the only correct values;
  // classifier metadata is set by the server-side path that runs the classifier.
})
