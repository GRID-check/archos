/**
 * The internal service token, both ways across the BFF ↔ backend seam.
 *
 * Inbound (backend → BFF over the compose network): `requireInternalToken`,
 * the guard every `/api/internal/*` route goes through. Requests authenticate
 * with INTERNAL_API_TOKEN via the `x-internal-token` header (or its old name); the
 * well-known dev default is refused outside dev environments; an unconfigured
 * token disables the endpoint.
 *
 * Outbound (BFF → backend): `internalServiceHeaders`, the one producer of that
 * header. Nothing else writes it (`internal-auth.spec.ts` scans `src/`).
 *
 * Leaf-safe: no AuthKit import, so the session-less job client can use it.
 */

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { ServiceUnavailableError } from '@/lib/api/errors'
import { readHeader } from '@/lib/http/legacy-header-names'

/** The service token's header. `readHeader` also takes its old name, `x-grid-internal-token`, until the contract step. */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token'

/**
 * Which secret a route checks. The service token authorizes backend → BFF
 * calls (memory writes among them); a credential handed to something outside
 * the cluster gets its own, so leaking it opens exactly one route.
 */
export type InternalTokenEnv = 'INTERNAL_API_TOKEN' | 'CORPUS_EXPORT_TOKEN'

const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const DEV_APP_ENVS = new Set(['development', 'dev', 'local'])

function tokensMatch(provided: string | null, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function isDevEnvironment(): boolean {
  const env = (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'production').toLowerCase()
  return DEV_APP_ENVS.has(env)
}

/**
 * The secret `tokenEnv` names, or null when it must not be used: unset, or the
 * well-known dev default outside a dev environment. For a key DERIVED from it
 * (an HMAC over a domain label), the same fail-closed rule the guard below
 * applies to the token itself.
 */
export function usableInternalSecret(tokenEnv: InternalTokenEnv = 'INTERNAL_API_TOKEN'): string | null {
  const secret = process.env[tokenEnv]
  if (!secret) return null
  if (secret === DEV_DEFAULT_TOKEN && !isDevEnvironment()) return null
  return secret
}

/**
 * Returns a rejection Response, or null when the request is authorized.
 * Usage: `const denied = requireInternalToken(request); if (denied) return denied`
 */
export function requireInternalToken(
  request: Request,
  label: string,
  tokenEnv: InternalTokenEnv = 'INTERNAL_API_TOKEN'
): Response | null {
  const expectedToken = process.env[tokenEnv]
  if (!expectedToken) {
    console.error(`[${label}] ${tokenEnv} is not configured — rejecting`)
    return NextResponse.json({ error: 'Internal API disabled' }, { status: 503 })
  }
  if (expectedToken === DEV_DEFAULT_TOKEN && !isDevEnvironment()) {
    console.error(
      `[${label}] ${tokenEnv} is the well-known dev default in a non-dev environment — refusing to serve.`,
    )
    return NextResponse.json({ error: 'Internal API disabled' }, { status: 503 })
  }
  if (!tokensMatch(readHeader(request.headers, INTERNAL_TOKEN_HEADER), expectedToken)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

/**
 * Whether the shared internal token may travel to `baseUrl`.
 *
 * HTTPS always qualifies. Plain HTTP qualifies only for destinations that cannot
 * leave the deployment's own network: loopback, an RFC1918/link-local/CGNAT
 * address, `.internal`/`.local`, or a single-label hostname — which is what a
 * compose service name (`aiq-api`) or a Kubernetes short name looks like.
 * Anything else is a public host over cleartext and does not get the secret.
 */
export function isTokenSafeDestination(baseUrl: string): boolean {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true
  if (host.endsWith('.internal') || host.endsWith('.local')) return true
  // No dot and no colon: a container/service short name, resolvable only inside
  // the deployment's own network.
  if (!host.includes('.') && !host.includes(':')) return true

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true
  return false
}

/**
 * Why a call to the backend cannot carry the service token. A 503: the
 * deployment, not the caller, is what is wrong, and a request sent without the
 * token would only come back as the backend's 401 or 403 and hide that.
 */
export class InternalServiceUnavailableError extends ServiceUnavailableError {
  constructor(
    readonly reason: 'token_missing' | 'unsafe_destination',
    message: string
  ) {
    super(message, { reason })
    this.name = 'InternalServiceUnavailableError'
  }
}

/**
 * The service-token header for one call to the backend at `destination` (the
 * base URL the call is sent to). The one producer of `x-internal-token`.
 *
 * One policy for every caller: no token, or a destination the token must not
 * travel to (`isTokenSafeDestination`), throws `InternalServiceUnavailableError`
 * and nothing is sent. Every backend route that reads the header refuses a
 * request without a valid one (`routes/internal_auth.py`, the envelope
 * middleware's internal-caller exemption), so an empty header only ever bought
 * a misleading 403. A caller whose backend route also answers without the
 * token (the llm-defaults read in an anonymous dev setup) catches the error and
 * says so, as `lib/model-config/backend-defaults.ts` does.
 */
export function internalServiceHeaders(destination: string): Record<string, string> {
  const token = process.env.INTERNAL_API_TOKEN
  if (!token) {
    throw new InternalServiceUnavailableError('token_missing', 'INTERNAL_API_TOKEN is not configured')
  }
  if (!isTokenSafeDestination(destination)) {
    throw new InternalServiceUnavailableError(
      'unsafe_destination',
      'Withholding the internal token: the backend URL is plain HTTP to a non-internal host'
    )
  }
  return { [INTERNAL_TOKEN_HEADER]: token }
}
