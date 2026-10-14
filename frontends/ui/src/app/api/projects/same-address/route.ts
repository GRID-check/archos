/**
 * `GET /api/projects/same-address?label=&lat=&lon=`: the projects the caller may
 * open that sit at the address just chosen in the create dialog, at most three
 * (`{ projects: [{ id, name, status }] }`). Thin handler; the match and the
 * access filter live in `@/lib/projects/same-address`.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { findProjectsAtAddress } from '@/lib/projects/same-address'

const sameAddressQuerySchema = z.object({
  label: z.string().trim().min(3).max(300),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
})

export const GET = apiRoute(
  async ({ session, request }) => ({
    projects: await findProjectsAtAddress(session, parseQuery(request, sameAddressQuerySchema)),
  }),
  { authz: { enforcedBy: 'findProjectsAtAddress (per-project FGA filter, as the projects list, ADR-0038)' } }
)
