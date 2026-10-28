/**
 * A project's bin (ADR-0088): the deleted folders and the documents binned on
 * their own that the reader may read, one page at a time (`?limit=`,
 * `?cursor=` from the previous page's `nextCursor`), who deleted each and when,
 * when its purge runs, and what the reader may do about it. Thin handler;
 * `@/lib/projects/folder-bin` decides.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listFolderBin } from '@/lib/projects/folder-bin'
import { binListQuerySchema } from '@/lib/projects/folder-bin-wire'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => listFolderBin(session, params.id, parseQuery(request, binListQuerySchema)),
  { authz: { enforcedBy: 'listFolderBin (project:view; each entry only when its folder is readable)' } }
)
