/** What each of the card's controls calls, by role, from the catalog's own list (`catalog/app-views.ts`). */

import { APP_TOOLS, APP_VIEWS, PROPOSAL_CARD_URI, type AppToolName } from '@/lib/agent-api/catalog/app-views'

function appTool(operation: 'proposal-apply' | 'proposal-dismiss'): AppToolName {
  const tool = APP_TOOLS.find((entry) => entry.view === PROPOSAL_CARD_URI && entry.operation === operation)
  if (!tool) throw new Error(`No app-only tool runs ${operation}`)
  return tool.name
}

const view = APP_VIEWS.find((entry) => entry.uri === PROPOSAL_CARD_URI)

export const PROPOSAL_CARD_TOOLS_BY_ROLE = {
  /** The model-visible read whose result the card draws, called again by the card to re-read. */
  get: view?.drawsResultOf[0] ?? 'proposal-get',
  apply: appTool('proposal-apply'),
  dismiss: appTool('proposal-dismiss'),
} as const
