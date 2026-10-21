/**
 * INTERNAL: the folder cards of ADR-0127, tier 1 of the file tools. The Python
 * builder writes a card here (`PUT`), `list_files` reads a collection's cards
 * (`GET`), and the builder removes the card of a folder that has nothing left to
 * describe (`DELETE`). The BFF is the card's one writer (ADR-0003).
 *
 * A folder is named by its collection and its path inside it, and resolved to
 * its id inside the organization the body names; a collection that is not that
 * organization's, or a path with no living folder, is a 404. A restricted
 * folder is its own collection, so its card is read and written under that
 * collection alone (ADR-0088).
 *
 * Service-to-service only: `GRID_INTERNAL_API_TOKEN` via `internalApiRoute`. The
 * organization is the caller's to state (the builder works for the organization
 * whose documents it read), and every query runs in that tenant scope.
 *
 * Contract: `lib/folder-cards/types.ts`; JSON Schema in
 * `tests/fixtures/folder-cards.schema.json`.
 */

import { NotFoundError } from '@/lib/api/errors'
import { internalApiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { deleteFolderCard, findCardFolder, getFolderCards, upsertFolderCard } from '@/lib/folder-cards/repository'
import {
  deleteFolderCardQuerySchema,
  getFolderCardsQuerySchema,
  putFolderCardRequestSchema,
  type GetFolderCardsResponse,
  type PutFolderCardResponse,
} from '@/lib/folder-cards/types'

const TENANCY = { tenancy: { fromPayload: 'organization_id in the body or query, the organization the card is built for' } }

const folderNotFound = () => new NotFoundError('No folder with that path in that collection.')

export const PUT = internalApiRoute(
  'folder-cards',
  async ({ request }): Promise<PutFolderCardResponse> => {
    const body = await parseJsonBody(request, putFolderCardRequestSchema)
    return withTenant({ organizationId: body.organization_id }, async () => {
      const folder = await findCardFolder(body.organization_id, body.collection, body.folder_path)
      if (!folder) throw folderNotFound()
      await upsertFolderCard(body.organization_id, folder, body)
      return { folder_id: folder.folderId, status: body.status }
    })
  },
  TENANCY,
)

export const GET = internalApiRoute(
  'folder-cards',
  async ({ request }): Promise<GetFolderCardsResponse> => {
    const { organization_id, collection } = parseQuery(request, getFolderCardsQuerySchema)
    const cards = await withTenant({ organizationId: organization_id }, () => getFolderCards(organization_id, collection))
    return { cards }
  },
  TENANCY,
)

export const DELETE = internalApiRoute(
  'folder-cards',
  async ({ request }): Promise<{ deleted: boolean }> => {
    const { organization_id, collection, folder_path } = parseQuery(request, deleteFolderCardQuerySchema)
    return withTenant({ organizationId: organization_id }, async () => {
      const folder = await findCardFolder(organization_id, collection, folder_path)
      if (!folder) throw folderNotFound()
      return { deleted: await deleteFolderCard(organization_id, folder) }
    })
  },
  TENANCY,
)
