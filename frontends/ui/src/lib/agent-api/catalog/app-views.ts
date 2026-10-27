/**
 * The catalog's MCP Apps (ADR-0142): the `ui://` views the door serves, and the
 * app-only tools a view calls.
 *
 * A view is a card of the A2UI catalog (ADR-0065) drawn inside another
 * assistant's chat, from a tool result, in a sandboxed iframe the host owns.
 * An app-only tool (`_meta.ui.visibility: ['app']`, MCP Apps 2026-01-26) is
 * not a new capability: it names the catalog operation it runs, so the route of
 * that operation, its `authz`, rate limit and schema, is the gate, exactly as
 * for the operation itself. What the app-only tool adds is who presses it: the
 * person, on the card, never the model. Who is offered each tool is its entry
 * in `exposure.config.ts` (`app: true`).
 *
 * Pure data, no server code: the view's bundle imports the names from here,
 * so the card and the door cannot disagree about what a button calls.
 */

import { z } from 'zod'
import type { OperationName } from './index'

/** The proposal card's resource: one HTML document, the same for every person and every proposal. */
export const PROPOSAL_CARD_URI = 'ui://piloti/proposal-card'

export interface AppView {
  readonly uri: string
  /** `resources/list`'s name: kebab-case, like the catalog. */
  readonly name: string
  readonly title: string
  readonly description: string
  /** The built document under `mcp-app-views/` (`scripts/build-mcp-app-views.ts`). */
  readonly file: string
  /** The operations whose result the view draws: their tool carries `_meta.ui.resourceUri`. */
  readonly drawsResultOf: readonly OperationName[]
}

export const APP_VIEWS = [
  {
    uri: PROPOSAL_CARD_URI,
    name: 'proposal-card',
    title: 'Piloti proposal',
    description:
      'Piloti’s card for one proposed change, drawn from the proposal-get result: what it would do, and Apply and Discard for the person.',
    file: 'proposal-card.html',
    drawsResultOf: ['proposal-get'],
  },
] as const satisfies readonly AppView[]

const proposalIdArgument = z.string().uuid().describe('The proposal id, from the proposal-get result the card shows.')

export interface AppTool {
  /** `<entity>-<verb>`, distinct from every operation name: the operation stays listed for the model. */
  readonly name: string
  readonly view: (typeof APP_VIEWS)[number]['uri']
  /** The catalog operation it runs, as the person. */
  readonly operation: OperationName
  readonly title: string
  readonly description: string
  /** Flat arguments, as a view's `callServerTool` sends them. */
  readonly input: z.ZodObject<z.ZodRawShape>
}

/** The proposal card's two buttons. Reading it again is `proposal-get` itself, which the model may call too. */
export const APP_TOOLS = [
  {
    name: 'proposal-card-apply',
    view: PROPOSAL_CARD_URI,
    operation: 'proposal-apply',
    title: 'Apply a proposal from its card',
    description:
      'Pressed by the person on the proposal card. Applies the proposal as the person through the proposal-apply route (409 if it was decided already).',
    input: z
      .object({
        id: proposalIdArgument,
        memoryScope: z.enum(['project']).optional().describe('A note: keep it in the project memory only.'),
      })
      .strict(),
  },
  {
    name: 'proposal-card-dismiss',
    view: PROPOSAL_CARD_URI,
    operation: 'proposal-dismiss',
    title: 'Discard a proposal from its card',
    description:
      'Pressed by the person on the proposal card. Discards the proposal through the proposal-dismiss route; nothing in the workspace changes.',
    input: z.object({ id: proposalIdArgument }).strict(),
  },
] as const satisfies readonly AppTool[]

export type AppToolName = (typeof APP_TOOLS)[number]['name']

/** What an app-only tool answers when the route refused: the route's status, so the card can tell a 409 apart. */
export interface AppToolRefusal {
  readonly status: number
  readonly code?: string
}
