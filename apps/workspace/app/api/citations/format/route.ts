/**
 * Citation formatting API — renders the CSL-JSON of an answer's sources into
 * BibTeX / RIS (.ris) / a formatted APA bibliography.
 *
 * Server-side because citation-js is a Node library (its core reaches for
 * `node:fs` and cannot be bundled for the browser). The request carries only
 * the CSL-JSON the client already holds; nothing is read from the database, so
 * this is a pure formatting endpoint behind the normal session guard.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { formatCitationsSchema } from '@/lib/citations/citation-wire'
import { renderCitations } from '@/lib/citations/render'

export const POST = apiRoute(
  async ({ request }) => {
    const { format, items } = await parseJsonBody(request, formatCitationsSchema)
    return { text: await renderCitations(items, format) }
  },
  {
    authz: {
      sessionOnly: true,
      why: 'pure formatting of citation text supplied in the request body; reads no stored data',
    },
  }
)
