import 'server-only'
/**
 * The session an agent call runs as (ADR-0121).
 *
 * Piloti's MCP server reaches the workspace through the same route handlers a
 * browser does, so every rule that lives at a route (the `authz` declaration,
 * the rate limit, the tenant slot, the body schema) applies to an agent too.
 * Those handlers learn who is asking from ONE function, `getGridSession()`,
 * which reads the AuthKit cookie. An agent has no cookie. This module is the
 * other answer `getGridSession()` may give: the person the MCP endpoint already
 * authenticated and resolved, bound to the async execution of one call.
 *
 * Only `lib/agent-api/dispatch.ts` enters it, and only with a session built by
 * `resolvePinnedRequesterSession`: the person's membership, role and
 * permissions as WorkOS states them now (ADR-0108). Nothing a request carries
 * can enter it, because no code reachable from a request passes a value to
 * {@link runAsActingSession} that it did not resolve itself.
 *
 * `AsyncLocalStorage.run` bounds the binding to the callback, so a call cannot
 * leak its person into the next request on the same socket.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuthorizedSession } from '@/lib/auth/types'

const acting = new AsyncLocalStorage<AuthorizedSession>()

/** Run `fn` with `session` as the answer `getGridSession()` gives. */
export function runAsActingSession<T>(session: AuthorizedSession, fn: () => Promise<T>): Promise<T> {
  return acting.run(session, fn)
}

/** The session bound by {@link runAsActingSession}, or `undefined` outside one. */
export function currentActingSession(): AuthorizedSession | undefined {
  return acting.getStore()
}
