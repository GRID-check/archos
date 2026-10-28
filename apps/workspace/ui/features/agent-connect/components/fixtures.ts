import type { AgentConnectState } from '../lib/connect-state'

/** One fixture per state the section can be in, for the specs and `/dev/connect-agent`. */
export const CONNECT_AGENT_FIXTURES = {
  ready: { availability: 'ready', url: 'https://app.piloti.at/api/mcp', canAdminister: false },
  orgDisabledMember: { availability: 'org-disabled', url: null, canAdminister: false },
  orgDisabledAdmin: { availability: 'org-disabled', url: null, canAdminister: true },
  notConfigured: { availability: 'not-configured', url: null, canAdminister: false },
  notConfiguredAdmin: { availability: 'not-configured', url: null, canAdminister: true },
} as const satisfies Record<string, AgentConnectState>
