import 'server-only'
/**
 * The person says yes in their own chat (ADR-0122, amendment "the person
 * confirms in their own chat"): before an outside agent's destructive write
 * runs, the door asks the person through the client, with MCP elicitation on
 * the 2026-07-28 multi-round-trip flow (`inputRequired`), and runs the call only
 * on their yes.
 *
 * Only ever in FRONT of a call that would run today. The question is asked when
 * every one of these holds, and otherwise the call takes today's path, byte for
 * byte:
 *
 *  - the request is of the 2026-07-28 era (the legacy path never builds a
 *    {@link Confirmation}, so Piloti's own client and every 2025-era client are
 *    untouched);
 *  - the caller is an outside agent (`actor: 'external_agent'`); Piloti never
 *    asks, its writes stay proposals;
 *  - the client declared form elicitation in the request's capabilities;
 *  - the operation is one the caller may see, the decision is `run`, and its
 *    annotations mark it a destructive write, or it is a decision the person
 *    makes (`personDecides`: applying or dismissing a proposal, ADR-0142);
 *  - a signing key exists ({@link requestStateKey}).
 *
 * The yes runs the call through `runOperation`'s whole path again:
 * visibility, the read gate, the route's own `authz`, rate limit and schema. So
 * the answer can never let through a call the door would refuse: it can only
 * stop one. The operation and its input travel to the second round in
 * `requestState`, HMAC-signed, bound to the person, the organization and the
 * client, and valid for {@link CONFIRMATION_TTL_SECONDS}; the second round must
 * repeat the same call. Neither `inputResponses` nor an unsigned state is
 * trusted: the SDK refuses a state that fails verification before a handler runs.
 */

import { createHmac } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  CLIENT_CAPABILITIES_META_KEY,
  type CallToolResult,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
} from '@modelcontextprotocol/server'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import { withTenant } from '@/lib/db/tenant-context'
import { usableInternalSecret } from '@/lib/internal-auth'
import { getProposal } from '@/lib/proposals/service'
import type { ProposedChangeView } from '@/lib/proposals/types'
import { type OperationInput, OperationInputError, validateOperationInput } from './dispatch'
import { type AgentOperation, annotationsOf } from './operation'
import { describeTargets, targetsOf } from './operation-targets'
import { findProjectName } from './operation-targets-repository'
import { clip, summaryOfOperation } from './operation-proposals'
import { callDecision, findVisibleOperation } from './policy'
import type { AgentPrincipal } from './principal'
import { type McpCallContext, recordOperationCalled } from './telemetry'
import { PRODUCT_NAME } from '@/lib/brand'

/** The key of the one input request: the person's yes or no. */
export const CONFIRM_INPUT = 'confirm'

/** How long the person has to answer; a later answer is refused and the agent calls again. */
export const CONFIRMATION_TTL_SECONDS = 300

/** What the second round carries: the call the person was asked about. */
export interface PendingCall {
  readonly operation: string
  readonly input: OperationInput
}

/** What a modern request's server holds to ask: the codec bound to this principal. */
export interface Confirmation {
  readonly codec: RequestStateCodec<PendingCall>
}

/** The form the client shows: one checkbox. */
const confirmSchema = () => ({
  type: 'object' as const,
  properties: {
    confirm: { type: 'boolean' as const, title: 'Confirm', description: 'Check to let the agent make this change as you.' },
  },
  required: [CONFIRM_INPUT],
})

/** Separates this key from every other use of the internal secret. */
const SIGNING_DOMAIN = 'grid:mcp-request-state:v1'

/**
 * The HMAC key for `requestState`: derived from `INTERNAL_API_TOKEN`, which
 * every deployment already provisions on every frontend pod, so a second round
 * served by another pod verifies. Null (no confirmation, today's behaviour) when
 * the secret is unset or the dev default outside dev, as for the token itself.
 */
export function requestStateKey(): Uint8Array | null {
  const secret = usableInternalSecret()
  if (!secret) return null
  return new Uint8Array(createHmac('sha256', secret).update(SIGNING_DOMAIN, 'utf8').digest())
}

/** Who the state is for: a state minted for one person, organization or client is refused for another. */
function bindingOf(principal: AgentPrincipal): string {
  return [principal.session.organizationId, principal.session.userId, principal.clientId ?? ''].join('\0')
}

/**
 * The confirmation for one request's server, or null when this principal is
 * never asked: Piloti, or no key. Called only for the 2026-07-28 era.
 */
export function confirmationFor(principal: AgentPrincipal, key: Uint8Array | null = requestStateKey()): Confirmation | null {
  if (principal.actor !== 'external_agent' || !key) return null
  const codec = createRequestStateCodec<PendingCall>({
    key,
    ttlSeconds: CONFIRMATION_TTL_SECONDS,
    bind: (ctx) => `${ctx.mcpReq.method}\0${bindingOf(principal)}`,
  })
  return { codec }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether the request's client declared form elicitation (2026-07-28: the
 * capabilities ride in every request's `_meta`). An empty `elicitation` object
 * means form, as the specification says.
 */
export function declaresFormElicitation(req: ServerContext): boolean {
  const envelope = req.mcpReq.envelope as Record<string, unknown> | undefined
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY]
  const elicitation = isRecord(capabilities) ? capabilities.elicitation : undefined
  if (!isRecord(elicitation)) return false
  return elicitation.form !== undefined || elicitation.url === undefined
}

/**
 * The operation `call` names if the person must confirm it: visible, run, and
 * a destructive write or a decision the person makes (`personDecides`: applying
 * or dismissing a proposal, which the model never decides for them).
 */
function operationToConfirm(principal: AgentPrincipal, call: PendingCall): AgentOperation | null {
  const op = findVisibleOperation(principal, call.operation)
  if (!op || callDecision(principal, op) !== 'run') return null
  if (op.personDecides) return op
  const annotations = annotationsOf(op)
  return !annotations.readOnlyHint && annotations.destructiveHint ? op : null
}

/** The project and document the call names, by the names the person reads; none when they cannot be read cheaply. */
async function namedTargets(principal: AgentPrincipal, op: AgentOperation, input: OperationInput): Promise<string[]> {
  const { session } = principal
  try {
    const views = await withTenant({ organizationId: session.organizationId, userId: session.userId }, () =>
      describeTargets(session, op, input),
    )
    return views.flatMap((view) => (view.name ? [`${view.type.replace('_', ' ')} "${view.name}"`] : []))
  } catch {
    return []
  }
}

/** At most `max` characters of `text`, on one line: the summaries' own `clip`, after the line breaks are gone. */
const oneLine = (text: string, max = 160): string => clip(text.replace(/\s+/g, ' ').trim(), max)

/** What a proposal would do, in the person's terms: its kind, its summary and what it names. */
export function describeProposal(proposal: ProposedChangeView): string {
  switch (proposal.kind) {
    case 'operation': {
      const named = (proposal.targets ?? []).flatMap((target) =>
        target.name ? [`${target.type.replace('_', ' ')} "${oneLine(target.name, 80)}"`] : [],
      )
      const on = named.length > 0 ? `, on ${named.join(', ')}` : ''
      return `an action, "${oneLine(proposal.payload.summary)}" (${proposal.payload.operation})${on}`
    }
    case 'file_operation': {
      const files = proposal.payload.operations.map((item) => (item.document ? `"${oneLine(item.document, 80)}"` : 'a file'))
      const shown = files.length > 3 ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more` : files.join(', ')
      return `a file ${proposal.payload.operation} of ${files.length === 1 ? 'one file' : `${files.length} files`}: ${shown}`
    }
    case 'memory':
      return `a note for ${PRODUCT_NAME} to remember (${proposal.payload.kind}): "${oneLine(proposal.payload.content)}"`
    case 'project_profile':
      return `a change to the project context, "${oneLine(proposal.payload.title)}"`
  }
}

/**
 * The proposal a decision names, read as the person, and its project's name:
 * what the person is asked to apply or discard. Null when it cannot be read
 * (gone, not theirs to read): the route will answer that, and the question
 * falls back to the operation's own words.
 */
async function decidedProposal(principal: AgentPrincipal, input: OperationInput): Promise<{ proposal: ProposedChangeView; project: string | null } | null> {
  const id = input.params?.id
  if (typeof id !== 'string') return null
  const { session } = principal
  try {
    return await withTenant({ organizationId: session.organizationId, userId: session.userId }, async () => {
      const proposal = await getProposal(session, id)
      const project = proposal.projectId ? await findProjectName(session.organizationId, proposal.projectId) : null
      return { proposal, project }
    })
  } catch {
    return null
  }
}

/** The question for deciding a proposal: what it does, on what, in which project. */
async function decisionMessage(principal: AgentPrincipal, op: AgentOperation, input: OperationInput): Promise<string | null> {
  const read = await decidedProposal(principal, input)
  if (!read) return null
  const verb = op.name === 'proposal-dismiss' ? 'discard' : 'apply'
  const where = read.project ? ` In project "${oneLine(read.project, 80)}".` : ''
  const effect = verb === 'discard' ? ' Discarding changes nothing in the workspace.' : ''
  return (
    `An agent connected to ${PRODUCT_NAME} wants to ${verb} this ${PRODUCT_NAME} proposal as you: ${describeProposal(read.proposal)}.` +
    `${where}${effect} Nothing happens unless you confirm.`
  )
}

/** What the person reads: what will change, on what, and that nothing does without them. */
export async function confirmationMessage(principal: AgentPrincipal, op: AgentOperation, input: OperationInput): Promise<string> {
  // Deciding a proposal: the person reads what the proposal does, not "apply a proposed change (id: …)".
  const decision = op.personDecides ? await decisionMessage(principal, op, input) : null
  if (decision) return decision
  const what = summaryOfOperation(op, input).replace(/\.$/, '')
  const targets = await namedTargets(principal, op, input)
  const on = targets.length > 0 ? ` This affects ${targets.join(', ')}.` : ''
  return `An agent connected to ${PRODUCT_NAME} wants to make this change as you: ${what}.${on} Nothing changes unless you confirm.`
}

/** What the agent reads when the person said no: nothing changed, and not to try again unasked. */
export function declinedResult(op: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `The person did not confirm ${op}, so nothing was changed. Do not call it again unless they ask you to.`,
      },
    ],
    structuredContent: { decision: 'declined', operation: op, changed: false },
  }
}

const MISMATCH =
  'The confirmation the person gave was for a different call, so nothing was changed. Call the operation again to ask them.'

/** The audit line for the person's answer: who decided (the person), through what, and how it ended. */
function auditDecision(
  principal: AgentPrincipal,
  op: AgentOperation,
  input: OperationInput,
  decision: 'applied' | 'failed' | 'declined',
): void {
  let targets: { type: string; id: string }[] = []
  try {
    targets = targetsOf(op, input).filter((target) => target.type === 'project' || target.type === 'document')
  } catch {
    // Too many to name: the line still records the decision.
  }
  recordAuditEventAfterCommit({
    action: 'agent.operation.decided',
    organizationId: principal.session.organizationId,
    actor: { userId: principal.session.userId, email: principal.session.email || null },
    targetType: 'organization',
    targetId: principal.session.organizationId,
    alsoTargets: targets,
    metadata: { operation: op.name, decision, decisionSource: 'elicitation', clientId: principal.clientId ?? '' },
  })
}

/**
 * Run `call` for `ctx`, asking the person first when {@link operationToConfirm}
 * says so and the request can carry the question; `run` is today's path for the
 * same call, which every case but the question itself ends in. `call` is null
 * when the arguments name no catalog operation (a read tool, an unparseable
 * call): then it is `run`, unchanged.
 */
export async function confirmThenRun(
  ctx: McpCallContext,
  req: ServerContext,
  call: PendingCall | null,
  run: (ctx: McpCallContext) => Promise<CallToolResult>,
): Promise<CallToolResult | InputRequiredResult> {
  const confirmation = ctx.confirmation
  if (!confirmation) return run(ctx)
  // Verified and bound by the SDK before this handler runs (`requestState.verify`); absent when the round carried none.
  const pending = req.mcpReq.requestState<PendingCall>()
  if (isRecord(pending)) return answered(ctx, req, confirmation, call, pending as PendingCall, run)
  if (!call || !declaresFormElicitation(req)) return run(ctx)
  const op = operationToConfirm(ctx.principal, call)
  if (!op) return run(ctx)
  try {
    validateOperationInput(op, call.input)
  } catch (error) {
    // A call the route would refuse is refused as today, never put to the person.
    if (error instanceof OperationInputError) return run(ctx)
    throw error
  }
  return ask(ctx, req, confirmation, op, call)
}

async function ask(
  ctx: McpCallContext,
  req: ServerContext,
  confirmation: Confirmation,
  op: AgentOperation,
  call: PendingCall,
): Promise<InputRequiredResult> {
  const startedAt = Date.now()
  const requestState = await confirmation.codec.mint({ operation: op.name, input: call.input }, req)
  const message = await confirmationMessage(ctx.principal, op, call.input)
  recordOperationCalled(ctx, { operation: op.name, domain: op.domain, decision: 'confirm', status: 202, startedAt })
  return inputRequired({
    inputRequests: { [CONFIRM_INPUT]: inputRequired.elicit({ message, requestedSchema: confirmSchema() }) },
    requestState,
  })
}

/** The second round: the person answered (or the client re-sent without an answer, and is asked again). */
async function answered(
  ctx: McpCallContext,
  req: ServerContext,
  confirmation: Confirmation,
  call: PendingCall | null,
  pending: PendingCall,
  run: (ctx: McpCallContext) => Promise<CallToolResult>,
): Promise<CallToolResult | InputRequiredResult> {
  if (!call || call.operation !== pending.operation || !isDeepStrictEqual(call.input ?? {}, pending.input ?? {})) {
    return { isError: true, content: [{ type: 'text', text: MISMATCH }] }
  }
  const op = operationToConfirm(ctx.principal, call)
  // No longer one to confirm (it left the door, or stopped being destructive): today's path decides.
  if (!op) return run(ctx)
  const answer = inputResponse(req.mcpReq.inputResponses, CONFIRM_INPUT)
  if (answer.kind !== 'elicit') return ask(ctx, req, confirmation, op, call)
  if (answer.action !== 'accept' || answer.content?.confirm !== true) {
    recordOperationCalled(ctx, { operation: op.name, domain: op.domain, decision: 'declined', status: 200, startedAt: Date.now() })
    auditDecision(ctx.principal, op, call.input, 'declined')
    return declinedResult(op.name)
  }
  const result = await run({ ...ctx, decisionSource: 'elicitation' })
  auditDecision(ctx.principal, op, call.input, result.isError ? 'failed' : 'applied')
  return result
}
