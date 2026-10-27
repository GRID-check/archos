/**
 * The one reading of `exposure.config.ts`: who a name is offered to, and on
 * which door (ADR-0122, amendment of 2026-10-21). `policy.ts` adds the
 * per-call guards of sensitive operations on top (`canSee`); the OpenAPI
 * document, the A2A door and the proposal applier read these directly. Kept
 * free of server code, so a spec or a fixture writer can import it.
 */

import { EXPOSURE, type Exposure } from './exposure.config'
import type { AgentPrincipal } from './principal'

/**
 * The doors agents reach the catalog through. `office` is every door an office's
 * agents use: `/api/mcp`, the A2A door (`/api/a2a`) and Piloti's own workspace
 * door. The operator console (`platform`) is GRID's, not an office's: every
 * write there (defaults, prices, keys) reaches every tenant. Its door is a
 * second MCP server for platform staff, `/api/platform/mcp` (ADR-0126), that
 * offers exactly what `exposure.config.ts` marks `platform`.
 */
export type AgentDoor = 'office' | 'platform'

/**
 * Who is looking, as `exposure.config.ts` has a column for it: an outside
 * agent on an office door, in-product Piloti, or platform staff on the
 * platform door.
 */
export type Audience = 'external' | 'piloti' | 'platform'

/** The door `principal` was resolved on: the platform door's own, else an office door. */
export function doorOfPrincipal(principal: Pick<AgentPrincipal, 'door'>): AgentDoor {
  return principal.door ?? 'office'
}

export function audienceOf(principal: Pick<AgentPrincipal, 'actor' | 'door'>): Audience {
  if (doorOfPrincipal(principal) === 'platform') return 'platform'
  return principal.actor === 'piloti' ? 'piloti' : 'external'
}

function exposureOf(name: string): Exposure | undefined {
  return Object.hasOwn(EXPOSURE, name) ? (EXPOSURE as Readonly<Record<string, Exposure>>)[name] : undefined
}

/**
 * Whether `exposure.config.ts` offers `name` to `audience`: THE visibility
 * rule. A name without an entry is offered to nobody (the spec fails the
 * catalog first), a withheld one to nobody, and `piloti: 'native:<tool>'` is
 * not offered to Piloti, which uses that tool instead.
 */
export function isExposedTo(audience: Audience, name: string): boolean {
  const entry = exposureOf(name)
  if (!entry || entry.withheld) return false
  if (audience === 'external') return entry.external
  if (audience === 'piloti') return entry.piloti === true
  return entry.platform === true
}

/**
 * Whether `name` is offered on `door` to anyone: on an office door, to an
 * outside agent or to Piloti (a native mapping included); on the platform door,
 * to its staff. Off the door, a name reads as unknown to everyone, never as a
 * hint; the applier refuses an old proposal of one (`operation-applier.ts`).
 * Hiding an operation from Piloti behind a native tool keeps it on the office
 * door, so a proposal filed before still applies.
 */
export function isOnDoor(name: string, door: AgentDoor = 'office'): boolean {
  const entry = exposureOf(name)
  if (!entry || entry.withheld) return false
  return door === 'platform' ? entry.platform === true : entry.external || entry.piloti !== false
}

/**
 * Whether the app-only tool `name` (`catalog/app-views.ts`) is offered to a view
 * in `audience`'s host: an outside agent's only, since only an outside agent's
 * host draws MCP Apps. Piloti's own door and the platform door list none.
 */
export function isAppToolFor(audience: Audience, name: string): boolean {
  const entry = exposureOf(name)
  return audience === 'external' && entry?.app === true && !entry.withheld
}

/** The native tool Piloti does `name` with, when the config names one: `remember` for `project-memory-create`. */
export function nativeToolOf(name: string): string | undefined {
  const piloti = exposureOf(name)?.piloti
  return typeof piloti === 'string' ? piloti.slice('native:'.length) : undefined
}
