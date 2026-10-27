/**
 * The receipt card's transport inside an MCP Apps host (ADR-0142): reads and
 * decisions as `tools/call` to Piloti's door, which the host carries for the
 * view (`App.callServerTool`). The view has no cookie and no network of its
 * own (`connect-src 'none'`); the door runs each call as the person who
 * connected their assistant, through the proposal's own routes.
 *
 * The first read is the tool result the host handed the view: the card is
 * drawn without a round trip. A host may replay a stored result (a
 * conversation reopened a day later), so the seed can be stale: with no channel
 * (`live: false`) the card re-reads an open proposal once in the background
 * (`useServerProposal`), and every later read (that one, a 409's) asks the
 * server. A colleague's decision shows on the next read, not live.
 */

import type { App } from '@modelcontextprotocol/ext-apps/react-with-deps'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { PROPOSAL_CARD_TOOLS_BY_ROLE } from './tool-names'
import { ProposalRequestError } from '@/lib/proposals/client'
import { proposalResponseSchema, type ApplyProposalRequest, type ProposalResponse } from '@/lib/proposals/types'
import type { ProposalTransport } from '@/features/grid-cards/hooks/proposal-transport'

/** The proposal a tool result carries (`structuredContent.proposal`), or null when it carries none. */
export function proposalOfResult(result: Partial<Pick<CallToolResult, 'structuredContent' | 'isError'>> | null | undefined): ProposalResponse | null {
  if (!result || result.isError) return null
  const parsed = proposalResponseSchema.safeParse(result.structuredContent)
  return parsed.success ? parsed.data : null
}

/** The route's status on a refused call (`structuredContent.status`); 500 when the result does not say. */
function refusalOf(result: CallToolResult): ProposalRequestError {
  const content = (result.structuredContent ?? {}) as { status?: unknown; code?: unknown }
  const status = typeof content.status === 'number' ? content.status : 500
  const code = typeof content.code === 'string' ? content.code : 'UNKNOWN'
  const text = result.content?.find((item: CallToolResult['content'][number]) => item.type === 'text')
  return new ProposalRequestError(status, code, text && 'text' in text ? text.text : `The call was refused (${status}).`)
}

type ToolCaller = Pick<App, 'callServerTool'>

async function call(app: ToolCaller, name: string, args: Record<string, unknown>): Promise<ProposalResponse> {
  const result = await app.callServerTool({ name, arguments: args })
  if (result.isError) throw refusalOf(result)
  const proposal = proposalOfResult(result)
  if (!proposal) throw new ProposalRequestError(502, 'UNREADABLE', `${name} answered without a proposal.`)
  return proposal
}

/** The transport for one view: `initial` answers the first read of its own proposal. */
export function appProposalTransport(app: ToolCaller, initial: ProposalResponse | null): ProposalTransport {
  let seed = initial
  return {
    live: false,
    get: (id) => {
      if (seed && seed.proposal.id === id) {
        const first = seed
        seed = null
        return Promise.resolve(first)
      }
      return call(app, PROPOSAL_CARD_TOOLS_BY_ROLE.get, { params: { id } })
    },
    apply: (id, body?: ApplyProposalRequest) => {
      seed = null
      return call(app, PROPOSAL_CARD_TOOLS_BY_ROLE.apply, { id, ...(body?.memoryScope ? { memoryScope: body.memoryScope } : {}) })
    },
    dismiss: (id) => {
      seed = null
      return call(app, PROPOSAL_CARD_TOOLS_BY_ROLE.dismiss, { id })
    },
  }
}
