/** The knowledge operations (ADR-0122). See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for the rules. */

import { z } from 'zod'
import { geocodeQuerySchema } from '@/lib/geocoding/types'
import { risDocumentQuerySchema } from '@/lib/ris/document-wire'
import type { AgentOperation } from '../operation'

export const knowledgeOperations = [
  {
    name: 'knowledge-base-get',
    domain: 'knowledge',
    summary: 'See what the building-law corpus contains',
    description:
      'The status of the platform-owned base corpus (OIB guidelines and the like): which documents it holds and ' +
      'whether they are indexed. Identical for every organization. To search the corpus, ask a question in a ' +
      'conversation; this only lists what is there.',
    method: 'GET',
    path: '/api/knowledge-base',
    load: () => import('@/app/api/knowledge-base/route'),
  },
  {
    name: 'ris-document-get',
    domain: 'knowledge',
    summary: 'Read the text of a RIS legal document',
    description:
      'Fetch the text of an Austrian RIS document from a citation: `reference` is a document number ' +
      '(NOR40217157) or a https://www.ris.bka.gv.at/ URL, `application` disambiguates a bare number, and ' +
      '`passage` windows a long document around the cited passage. Answers 404 when RIS serves no text for it ' +
      'and 502 when RIS is unreachable. Rate limited.',
    method: 'GET',
    path: '/api/ris/document',
    query: risDocumentQuerySchema,
    load: () => import('@/app/api/ris/document/route'),
  },
  {
    name: 'address-search',
    domain: 'knowledge',
    summary: 'Look up an address',
    description:
      'Search public map data for an address (`q`, at least 3 characters; `limit` caps results). Answers ' +
      '`{ enabled, results }`; `enabled: false` means no geocoding provider is configured. Use it to resolve an ' +
      'address before creating a project.',
    method: 'GET',
    path: '/api/geocode',
    query: geocodeQuerySchema,
    load: () => import('@/app/api/geocode/route'),
  },
  {
    name: 'widget-token-get',
    domain: 'knowledge',
    summary: 'Mint a short-lived WorkOS widget token',
    description:
      'A user-specific, short-lived WorkOS widget authorization token (never cache it) for the requested ' +
      '`scope` values; scopes the person does not hold are dropped. `org=platform` asks for the platform ' +
      'organization and is guarded. Returns `{ token }`. Only useful to a client that renders WorkOS widgets.',
    method: 'GET',
    path: '/api/widgets/token',
    // The route reads `searchParams` directly rather than through `parseQuery`; it is the gate.
    query: z.object({
      scope: z.string().optional().describe('A widget scope; repeat the parameter for several.'),
      org: z.string().optional().describe('Pass `platform` for the platform organization.'),
    }),
    load: () => import('@/app/api/widgets/token/route'),
  },
  {
    name: 'knowledge-document-get',
    domain: 'knowledge',
    summary: 'Read a base-corpus PDF',
    description:
      'The PDF of one document of the building-law base corpus (the file names are listed by knowledge-base-get), returned as an ' +
      'attached resource up to 5 MiB; a larger file is not sent. Identical for every organization. Use it to quote a source a ' +
      'citation points at.',
    method: 'GET',
    path: '/api/knowledge-base/documents/[fileName]',
    params: z.object({ fileName: z.string().describe('The base-corpus file name, exactly as knowledge-base-get lists it.') }),
    binaryResponse: ['application/pdf'],
    load: () => import('@/app/api/knowledge-base/documents/[fileName]/route'),
  },

] as const satisfies readonly AgentOperation[]
