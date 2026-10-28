/**
 * What the profile's "Agent verbinden" section may show a person (ADR-0122).
 *
 * Decided on the server, so the page never offers a URL that leads to a
 * refusal and never ships an environment value: the client island receives a
 * three-way answer, the MCP URL (only when it is usable) and one boolean.
 *
 * Order matters. A deployment without the external door cannot be fixed by an
 * organization admin, so that answer wins over the organization's flag.
 */

import { authkitDomain, mcpResourceUrl } from '@/lib/agent-api/mcp-config'
import type { UserSession } from '@/lib/auth/types'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { ORG_PERMISSIONS, hasPermission } from '@/lib/authz/permissions'

export type AgentConnectAvailability = 'ready' | 'org-disabled' | 'not-configured'

export interface AgentConnectState {
  availability: AgentConnectAvailability
  /** The MCP server URL; `null` unless `availability` is `ready`. */
  url: string | null
  /** Whether this person holds the organization-settings permission. */
  canAdminister: boolean
}

export interface AgentConnectFacts {
  flagEnabled: boolean
  doorConfigured: boolean
  url: string | null
  canAdminister: boolean
}

/** The pure decision, separate from where its facts come from. */
export function deriveAgentConnectState(facts: AgentConnectFacts): AgentConnectState {
  const { flagEnabled, doorConfigured, url, canAdminister } = facts
  if (!doorConfigured || !url) return { availability: 'not-configured', url: null, canAdminister }
  if (!flagEnabled) return { availability: 'org-disabled', url: null, canAdminister }
  return { availability: 'ready', url, canAdminister }
}

type Env = Record<string, string | undefined>

export function loadAgentConnectState(
  session: Pick<UserSession, 'featureFlags' | 'role' | 'permissions'>,
  env: Env = process.env,
): AgentConnectState {
  return deriveAgentConnectState({
    flagEnabled: isFeatureEnabled(session, FEATURE_FLAGS.agentMcp),
    doorConfigured: authkitDomain(env) !== null,
    url: mcpResourceUrl(env)?.toString() ?? null,
    canAdminister: hasPermission(session, ORG_PERMISSIONS.settingsManage),
  })
}
