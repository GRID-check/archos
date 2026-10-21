/**
 * Internal LLM key resolution (ADR-0022, ADR-0121) — the single decryption
 * point for tenant LLM keys.
 *
 * Called just-in-time by the Python backend (chat rebuilds, research workers,
 * every OpenRouter call made for an organization) with the org id it already
 * carries; guarded by `GRID_INTERNAL_API_TOKEN`. Answers
 *
 *   - `credential`: the org's own BYOK key in use, or null (no active
 *     credential, platform mode, or the `byok-llm` flag off);
 *   - `platformKey`: the OpenRouter key the platform provisioned for the org,
 *     created on first use; null only when `perOrgKeys` is false;
 *   - `perOrgKeys`: whether this deployment has per-organization keys at all.
 *
 * Any failure to read or create a key is a 503, never a null: the backend
 * refuses the call rather than send it on the shared key (ADR-0121).
 *
 * The response contains the PLAINTEXT key: it must never be cached in the
 * shared cache, logged, or proxied beyond the internal network. The backend
 * holds it in process memory for at most its 60 s TTL.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { orgKeysEnabled, resolveOrgOpenrouterKey } from '@/lib/llm-credentials/org-keys'
import { resolveActiveCredentialForBackend } from '@/lib/llm-credentials/service'

const querySchema = z.object({
  organizationId: z.string().regex(/^org_[A-Za-z0-9]+$/, 'not a WorkOS organization id'),
})

export const GET = internalApiRoute(
  'llm-credential',
  async ({ request }) => {
    const { organizationId } = parseQuery(request, querySchema)
    // The org's own encrypted credential row and nothing else: row-level
    // security now backs the service's scoping rather than trusting it alone.
    const { credential, platformKey } = await withTenant({ organizationId }, async () => ({
      credential: await resolveActiveCredentialForBackend(organizationId),
      platformKey: await resolveOrgOpenrouterKey(organizationId),
    }))
    // The header the file header above has been asserting all along. This body
    // carries a plaintext key; without `no-store` nothing stops a proxy, a
    // service worker or a `fetch` cache from keeping it. `successResponse`
    // passes a Response through untouched, which is why it is built here.
    return NextResponse.json(
      { credential, platformKey, perOrgKeys: orgKeysEnabled() },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  },
  { tenancy: { fromPayload: '?organizationId' } }
)
