/**
 * One OpenRouter key per organization (ADR-0118).
 *
 * Every model call made for an organization goes out on that organization's own
 * OpenRouter key, so a leaked key, a runaway job or a provider's abuse block
 * costs one tenant, and its spend can be read and revoked at OpenRouter on its
 * own. The key is created through OpenRouter's management API
 * (`POST /api/v1/keys`) the first time the organization needs one, so existing
 * organizations need no backfill. It is stored like a BYOK key, in the secret
 * store, and served to the Python backend by `/api/internal/llm-credential`.
 *
 * There is no fallback: when the key cannot be read or created, the resolution
 * throws, the internal endpoint answers 503, and the backend refuses the call
 * rather than send it on the deployment's shared key.
 *
 * A deployment without `OPENROUTER_MANAGEMENT_KEY` (local development, CI) has
 * no per-organization keys at all and says so ({@link orgKeysEnabled}); every
 * call then runs on the shared key, as before ADR-0118. Production stacks are
 * required to set it (`deploy/pulumi`).
 *
 * Revoking an organization's key is done at OpenRouter (disable it there): its
 * calls then fail until it is enabled again.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { NotFoundError, ServiceUnavailableError } from '@/lib/api/errors'
import { isUniqueViolation } from '@/lib/db/errors'
import type { OrgOpenrouterKey } from '@/lib/db/schema'
import { getWorkOS } from '@/lib/workos/client'
import { ACTIVE_KEY_INDEX, getActiveOrgKey, insertActiveOrgKey } from './org-keys-repository'
import { deleteSecret, keyFingerprint, revealSecret, storeSecret } from './secret-store'

/** OpenRouter management key; BFF only, never sent to the backend. Unset = no per-org keys. */
const MANAGEMENT_KEY_ENV = 'OPENROUTER_MANAGEMENT_KEY'

/** The monthly backstop set on a key when it is created (USD), never the budget. Unset = no limit. */
const MONTHLY_LIMIT_ENV = 'OPENROUTER_ORG_KEY_MONTHLY_LIMIT_USD'

const REQUEST_TIMEOUT_MS = 10_000

/** How long a failed provisioning is remembered, so a failing org is not re-provisioned on every call. */
const PROVISION_FAILURE_TTL_MS = 30_000

/** What the backend receives for an organization's key — includes the PLAINTEXT key. */
export interface ResolvedOrgKey {
  id: string
  apiKey: string
  keyFingerprint: string
}

/** Whether this deployment gives every organization an OpenRouter key of its own. */
export function orgKeysEnabled(): boolean {
  return Boolean(process.env[MANAGEMENT_KEY_ENV]?.trim())
}

function openrouterBaseUrl(): string {
  return (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '')
}

/** The configured monthly backstop, or null for none. A value that is not a positive number is refused. */
export function monthlyLimitUsd(): number | null {
  const raw = process.env[MONTHLY_LIMIT_ENV]?.trim()
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new ServiceUnavailableError(`${MONTHLY_LIMIT_ENV} must be a positive number`)
  }
  return value
}

async function managementRequest(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${openrouterBaseUrl()}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${process.env[MANAGEMENT_KEY_ENV]?.trim()}`,
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    throw new ServiceUnavailableError('OpenRouter key management could not be reached')
  }
  if (!response.ok) {
    throw new ServiceUnavailableError(`OpenRouter key management refused the request (HTTP ${response.status})`)
  }
  return response.json()
}

interface CreatedKey {
  hash: string
  key: string
}

/** Create the organization's key at OpenRouter. Never logs the key. */
async function createOpenrouterKey(organizationId: string, limitUsd: number | null): Promise<CreatedKey> {
  const body = (await managementRequest('/keys', {
    method: 'POST',
    body: {
      name: `Piloti ${organizationId}`,
      ...(limitUsd === null ? {} : { limit: limitUsd, limit_reset: 'monthly' }),
      include_byok_in_limit: false,
    },
  })) as { key?: unknown; data?: { hash?: unknown } }
  const key = typeof body.key === 'string' ? body.key : ''
  const hash = typeof body.data?.hash === 'string' ? body.data.hash : ''
  if (!key || !hash) {
    throw new ServiceUnavailableError('OpenRouter created a key without returning it')
  }
  return { key, hash }
}

/** Best effort: a key that lost the provisioning race must not stay live at OpenRouter. */
async function deleteOpenrouterKey(hash: string): Promise<void> {
  try {
    await managementRequest(`/keys/${encodeURIComponent(hash)}`, { method: 'DELETE' })
  } catch (error) {
    console.error(`[Org keys] could not delete the spare OpenRouter key ${hash}; delete it at OpenRouter`, error)
  }
}

async function reveal(row: OrgOpenrouterKey): Promise<ResolvedOrgKey> {
  try {
    return { id: row.id, apiKey: await revealSecret(row), keyFingerprint: row.keyFingerprint }
  } catch (error) {
    console.error(`[Org keys] secret reveal failed for org ${row.organizationId} key ${row.id}:`, error)
    throw new ServiceUnavailableError('The organization’s OpenRouter key could not be read')
  }
}

/** A key is only ever created for an organization that exists: the internal caller names it, WorkOS vouches for it. */
async function requireOrganization(organizationId: string): Promise<void> {
  try {
    await getWorkOS().organizations.getOrganization(organizationId)
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 404) {
      throw new NotFoundError('Organization not found')
    }
    throw new ServiceUnavailableError('The organization could not be checked before its OpenRouter key was created')
  }
}

async function provision(organizationId: string): Promise<ResolvedOrgKey> {
  await requireOrganization(organizationId)
  const limitUsd = monthlyLimitUsd()
  const created = await createOpenrouterKey(organizationId, limitUsd)
  const id = randomUUID()
  let secretRef: Awaited<ReturnType<typeof storeSecret>> | null = null
  try {
    secretRef = await storeSecret(organizationId, id, created.key)
    const row = await insertActiveOrgKey({
      id,
      organizationId,
      openrouterKeyHash: created.hash,
      ...secretRef,
      keyFingerprint: keyFingerprint(created.key),
      limitUsd: limitUsd?.toString() ?? null,
    })
    return { id: row.id, apiKey: created.key, keyFingerprint: row.keyFingerprint }
  } catch (error) {
    // Whatever failed, the key we created must not stay live at OpenRouter.
    if (secretRef) await deleteSecret({ id, organizationId, ...secretRef })
    await deleteOpenrouterKey(created.hash)
    if (!isUniqueViolation(error, ACTIVE_KEY_INDEX)) throw error
    // Another replica provisioned first: keep its key.
    const winner = await getActiveOrgKey(organizationId)
    if (!winner) throw new ServiceUnavailableError('The organization’s OpenRouter key vanished while it was created')
    return reveal(winner)
  }
}

/** In-flight provisioning per organization, so one replica creates one key however many calls race. */
const provisioning = new Map<string, Promise<ResolvedOrgKey>>()
/** Organizations whose provisioning just failed, until when: a failing org must not create a key per call. */
const recentFailures = new Map<string, number>()

/**
 * The organization's OpenRouter key, created at OpenRouter when it has none yet.
 * Null only when this deployment has per-organization keys switched off
 * ({@link orgKeysEnabled}). Throws {@link ServiceUnavailableError} when the key
 * can be neither read nor created: there is no fallback.
 */
export async function resolveOrgOpenrouterKey(organizationId: string): Promise<ResolvedOrgKey | null> {
  if (!orgKeysEnabled()) return null
  const existing = await getActiveOrgKey(organizationId)
  if (existing) return reveal(existing)

  const inFlight = provisioning.get(organizationId)
  if (inFlight) return inFlight
  if ((recentFailures.get(organizationId) ?? 0) > Date.now()) {
    throw new ServiceUnavailableError('The organization’s OpenRouter key could not be created; retrying shortly')
  }
  const pending = provision(organizationId)
    .catch((error: unknown) => {
      recentFailures.set(organizationId, Date.now() + PROVISION_FAILURE_TTL_MS)
      throw error
    })
    .finally(() => provisioning.delete(organizationId))
  provisioning.set(organizationId, pending)
  return pending
}
