import 'server-only'
/**
 * Asking Piloti (ADR-0124) is the one door call whose wait is ours: the route
 * waits up to {@link ASK_WAIT_SECONDS} for Piloti's turn. On the 2026-07-28 era
 * the door offers two standard ways through that wait, each only to a client
 * that asked for it:
 *
 *  - **Progress** (`notifications/progress`): a `tools/call` of
 *    `agent-ask-create` that carries a `progressToken` starts the ask without
 *    waiting, then reads it with `agent-ask-get` in short waits and reports
 *    the elapsed seconds against the wait budget between them. The call still
 *    ends with the ask as `agent-ask-create` would have answered it.
 *  - **Tasks** (the `io.modelcontextprotocol/tasks` extension, SEP-2663): a
 *    client that declares the extension on the call gets a `CreateTaskResult`
 *    whose `taskId` is the ask id, the moment the ask is stored. `tasks/get`
 *    reads the ask, `tasks/cancel` stops it, `tasks/update` acknowledges (an
 *    ask never needs input). No new state: the ask row is the task.
 *
 * Both run through {@link executeOperation}, so each read is the person's own
 * `agent-ask-get` (the route refuses an ask that is not theirs), with the same
 * gate and telemetry as call-operation. A client that asks for neither, the
 * 2025-era path (Piloti's own client among it), and every actor whose writes
 * are proposals get today's call, unchanged.
 */

import {
  type CallToolResult,
  CLIENT_CAPABILITIES_META_KEY,
  type McpServer,
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
  type ServerContext,
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import { ASK_WAIT_SECONDS, type AskState, type AskView, isTerminalAskState } from '@/lib/agent-asks/ask-wire'
import { executeOperation, fromOperationResult, runOperation } from './discovery'
import { type OperationInput, type OperationResult, OperationInputError, validateOperationInput } from './dispatch'
import type { AgentOperation } from './operation'
import { callDecision, findVisibleOperation } from './policy'
import type { AgentPrincipal } from './principal'
import type { McpCallContext } from './telemetry'

/** The extension's identifier (SEP-2663). */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'

export const ASK_CREATE = 'agent-ask-create'
const ASK_GET = 'agent-ask-get'
const ASK_CANCEL = 'agent-ask-cancel'

/** The longest single read between two progress notifications. */
export const PROGRESS_STEP_SECONDS = 5

/** What a task tells a client to wait between polls when the ask names nothing. */
const DEFAULT_POLL_MS = 10_000

/** The ask operations, when `principal` runs all three itself; null when it cannot see one or would only propose. */
function askOperations(principal: AgentPrincipal): Record<'create' | 'get' | 'cancel', AgentOperation> | null {
  const create = findVisibleOperation(principal, ASK_CREATE)
  const get = findVisibleOperation(principal, ASK_GET)
  const cancel = findVisibleOperation(principal, ASK_CANCEL)
  if (!create || !get || !cancel) return null
  if ([create, get, cancel].some((op) => callDecision(principal, op) !== 'run')) return null
  return { create, get, cancel }
}

/** Whether the door offers the tasks extension to `principal`: only where it may ask Piloti itself. */
export const offersAskTasks = (principal: AgentPrincipal): boolean => askOperations(principal) !== null

/** Whether the request declared the tasks extension in its own capabilities, as SEP-2663 requires per request. */
export function declaresTasks(call: Pick<ServerContext, 'mcpReq'>): boolean {
  // The SDK types the envelope as `{}`; it holds the reserved keys the request carried, as received.
  const envelope: Record<string, unknown> = { ...call.mcpReq.envelope }
  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY]
  const extensions = isRecord(capabilities) ? capabilities.extensions : undefined
  return isRecord(extensions) && isRecord(extensions[TASKS_EXTENSION])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAskView(body: unknown): body is AskView {
  return isRecord(body) && typeof body.id === 'string' && typeof body.state === 'string'
}

type AskRead = { view: AskView; result: OperationResult } | { refusal: CallToolResult; status: number | null }

/** One ask call through the door's own path; the ask, or what the caller reads instead. */
async function callAsk(ctx: McpCallContext, op: AgentOperation, input: OperationInput): Promise<AskRead> {
  const outcome = await executeOperation(ctx, op, input)
  if ('refusal' in outcome) return { refusal: outcome.refusal, status: null }
  const { result } = outcome
  if (result.ok && isAskView(result.body)) return { view: result.body, result }
  return { refusal: fromOperationResult(op, result), status: result.status }
}

/** The wait the caller asked for: its `waitSeconds`, else the route's default. */
function waitBudget(input: OperationInput): number {
  const body = isRecord(input.body) ? input.body : {}
  return typeof body.waitSeconds === 'number' ? body.waitSeconds : ASK_WAIT_SECONDS
}

const STATUS_TEXT: Readonly<Record<AskState, string>> = {
  submitted: 'The question is recorded; Piloti has not started on it yet.',
  working: 'Piloti is working on the answer.',
  completed: 'Piloti answered.',
  canceled: 'The ask was canceled.',
  failed: 'The ask failed.',
  rejected: 'The ask was rejected.',
}

/**
 * `agent-ask-create` for a call that may carry a progress token or declare
 * tasks (`call` is null on the 2025-era path). Everything else is
 * {@link runOperation}, so a refusal reads exactly as it does today.
 */
export async function runAskCreate(
  ctx: McpCallContext,
  input: OperationInput,
  call: ServerContext | null,
): Promise<CallToolResult> {
  const ops = askOperations(ctx.principal)
  const token = call?.mcpReq._meta?.progressToken
  const tasks = call !== null && declaresTasks(call)
  const budget = waitBudget(input)
  if (!ops || !call || (!tasks && (token === undefined || budget === 0))) return runOperation(ctx, ASK_CREATE, input)
  try {
    validateOperationInput(ops.create, input)
  } catch (error) {
    // Refused before anything is stored: today's call words the refusal.
    if (error instanceof OperationInputError) return runOperation(ctx, ASK_CREATE, input)
    throw error
  }
  const startedAt = Date.now()
  const body = isRecord(input.body) ? input.body : {}
  const first = await callAsk(ctx, ops.create, { ...input, body: { ...body, waitSeconds: 0 } })
  if ('refusal' in first) return first.refusal
  // An ask that ended at once (budget, a busy thread) is answered as the call it was; a task would only wrap it.
  if (isTerminalAskState(first.view.state)) return fromOperationResult(ops.create, first.result)
  if (tasks) return createTaskResult(first.view)
  return waitWithProgress(ctx, ops, first, { call, token: token as string | number, budget, startedAt })
}

/** Read the ask in short waits until it ends or the budget is spent, reporting progress before each read. */
async function waitWithProgress(
  ctx: McpCallContext,
  ops: Record<'create' | 'get', AgentOperation>,
  first: { view: AskView; result: OperationResult },
  wait: { call: ServerContext; token: string | number; budget: number; startedAt: number },
): Promise<CallToolResult> {
  let current = first
  let reported = -1
  while (!isTerminalAskState(current.view.state) && !wait.call.mcpReq.signal.aborted) {
    // Seconds to the millisecond: the specification wants each notification's progress above the last.
    const elapsed = Math.round(Date.now() - wait.startedAt) / 1_000
    const remaining = Math.floor(wait.budget - elapsed)
    if (remaining < 1) break
    if (elapsed > reported) {
      reported = elapsed
      await wait.call.mcpReq.notify({
        method: 'notifications/progress',
        params: { progressToken: wait.token, progress: elapsed, total: wait.budget, message: STATUS_TEXT[current.view.state] },
      })
    }
    const next = await callAsk(ctx, ops.get, {
      params: { id: current.view.id },
      query: { waitSeconds: Math.min(PROGRESS_STEP_SECONDS, remaining) },
    })
    // A read refused mid-wait (a dropped connection to the database) is not the ask's end: answer with what is known.
    if ('refusal' in next) break
    current = next
  }
  return fromOperationResult(ops.create, current.result)
}

// --- the tasks extension ----------------------------------------------------------

interface TaskFields {
  taskId: string
  status: 'working' | 'completed' | 'cancelled'
  statusMessage?: string
  createdAt: string
  lastUpdatedAt: string
  ttlMs: null
  pollIntervalMs?: number
}

/** The task an ask is (SEP-2663 `Task`). The ask is kept with its conversation, so its TTL is unlimited. */
function taskOf(view: AskView): TaskFields {
  const terminal = isTerminalAskState(view.state)
  return {
    taskId: view.id,
    status: view.state === 'canceled' ? 'cancelled' : terminal ? 'completed' : 'working',
    statusMessage: view.reason ?? STATUS_TEXT[view.state],
    createdAt: view.createdAt,
    lastUpdatedAt: view.updatedAt,
    ttlMs: null,
    ...(terminal ? {} : { pollIntervalMs: (view.pollAfterSeconds ?? 0) * 1_000 || DEFAULT_POLL_MS }),
  }
}

/**
 * The `CreateTaskResult` for a stored ask: `resultType: "task"` and the task.
 * Typed as the tool result the SDK's callback returns; its encoder forwards a
 * `resultType` other than `complete` on `tools/call` verbatim, and adds an
 * empty `content`, which the open `Result` shape allows.
 */
function createTaskResult(view: AskView): CallToolResult {
  return { resultType: 'task', ...taskOf(view) } as unknown as CallToolResult
}

const taskParams = z.object({ taskId: z.string().min(1) }).passthrough()

const unknownTask = () => new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown task: no ask of yours has this id.')

/** A task request must declare the extension itself (SEP-2663, -32021). */
function requireDeclared(call: ServerContext): void {
  if (!declaresTasks(call)) {
    throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } })
  }
}

/** The ask a task id names, as its asker reads it; an id that names none of theirs is an unknown task. */
async function readTask(ctx: McpCallContext, op: AgentOperation, taskId: string): Promise<{ view: AskView; result: OperationResult }> {
  if (!z.guid().safeParse(taskId).success) throw unknownTask()
  const read = await callAsk(ctx, op, { params: { id: taskId } })
  if ('view' in read) return read
  if (read.status === 404) throw unknownTask()
  throw new ProtocolError(ProtocolErrorCode.InternalError, textOf(read.refusal))
}

const textOf = (result: CallToolResult): string =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join(' ').trim() || 'The ask could not be read.'

/**
 * `tasks/get`, `tasks/cancel` and `tasks/update` on `server`, for a caller
 * {@link offersAskTasks} is true for. Each runs as the person through the ask
 * operations, so the route's own rule (`requested_by` is the caller) decides
 * whose ask a task id reaches.
 */
export function registerAskTasks(server: McpServer, ctx: McpCallContext): void {
  const ops = askOperations(ctx.principal)
  if (!ops) return
  server.server.setRequestHandler('tasks/get', { params: taskParams }, async ({ taskId }, call) => {
    requireDeclared(call)
    const { view, result } = await readTask(ctx, ops.get, taskId)
    const task = taskOf(view)
    // A finished ask is the tool call's result, as agent-ask-create would have answered it; `failed` is kept for JSON-RPC errors.
    return task.status === 'completed' ? { ...task, result: fromOperationResult(ops.create, result) } : { ...task }
  })
  server.server.setRequestHandler('tasks/cancel', { params: taskParams }, async ({ taskId }, call) => {
    requireDeclared(call)
    if (!z.guid().safeParse(taskId).success) throw unknownTask()
    const read = await callAsk(ctx, ops.cancel, { params: { id: taskId } })
    // Cancellation is cooperative: an ask that already ended is acknowledged, and tasks/get shows how it ended.
    if ('view' in read || read.status === 409) return {}
    if (read.status === 404) throw unknownTask()
    throw new ProtocolError(ProtocolErrorCode.InternalError, textOf(read.refusal))
  })
  server.server.setRequestHandler('tasks/update', { params: taskParams }, async ({ taskId }, call) => {
    requireDeclared(call)
    // The SDK lifts `inputResponses` out of the params. Piloti never asks back mid-turn, so no input request is
    // ever outstanding: the responses are ignored, as SEP-2663 says of a key that is not outstanding.
    await readTask(ctx, ops.get, taskId)
    return {}
  })
}
