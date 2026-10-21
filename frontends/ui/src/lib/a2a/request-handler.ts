/**
 * The A2A door's request handler (ADR-0124): the SDK's `A2ARequestHandler`,
 * answered by the ask routes.
 *
 * Not a second path to the asks: every method calls `/api/piloti-asks` through
 * `callOperation`, the dispatcher the MCP door and accepted proposals use, as
 * the person the token names. The route's `authz`, rate limit (`chat-turn`),
 * tenant slot, body schema, the `piloti-ask` switch and the budget apply
 * exactly as for any other client. The SDK's JSON-RPC transport
 * (`JsonRpcTransportHandler`, and `LegacyJsonRpcTransportHandler` for 0.3)
 * parses the request, picks the method and serializes the answer.
 *
 * | A2A method (1.0 / 0.3) | Route |
 * |---|---|
 * | `SendMessage` / `message/send` | `POST /api/piloti-asks`, then `GET …/[id]?waitSeconds=` until the task ends; with `returnImmediately` (0.3: `blocking: false`) the ask waits 0 seconds and the task answers as it stands |
 * | `SendStreamingMessage` / `message/stream` | the same without the wait, as server-sent events: the task, each change of state, the artifacts, the end; an ask that ended at once is one event, the whole task |
 * | `GetTask` / `tasks/get` | `GET /api/piloti-asks/[id]` |
 * | `CancelTask` / `tasks/cancel` | `POST /api/piloti-asks/[id]/cancel` |
 * | `SubscribeToTask` / `tasks/resubscribe` | the stream of an existing task |
 *
 * A `contextId` the client made up starts a new conversation, whose id the
 * task carries back. Each method's call is recorded as a call on the agent door
 * (PostHog and Langfuse, door `a2a`); the dispatcher runs it with the agent as
 * reader, so a refusal reaches the client in English.
 *
 * Push notifications, `ListTasks` and the extended card are not offered.
 */

import 'server-only'
import type {
  AgentCard,
  CancelTaskRequest,
  GetExtendedAgentCardRequest,
  GetTaskRequest,
  ListTasksRequest,
  ListTasksResponse,
  ListTaskPushNotificationConfigsResponse,
  Message,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
  TaskPushNotificationConfig,
} from '@a2a-js/sdk'
import {
  ExtendedAgentCardNotConfiguredError,
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors'
import type { A2ARequestHandler } from '@a2a-js/sdk/server'
import { findOperation } from '@/lib/agent-api/catalog'
import { isExposedTo } from '@/lib/agent-api/exposure'
import { callOperation, type OperationInput, type OperationResult } from '@/lib/agent-api/dispatch'
import type { AgentPrincipal } from '@/lib/agent-api/principal'
import { recordOperationCalled } from '@/lib/agent-api/telemetry'
import type { AuthorizedSession } from '@/lib/auth/types'
import { ASK_WAIT_SECONDS, isTerminalAskState, type AskView } from '@/lib/piloti-asks/ask-wire'
import { askInputOf, artifactsOf, taskOf } from './task-mapping'

/** The longest a blocking `SendMessage` holds its request before it answers the task still working. */
export const BLOCKING_MAX_MS = 5 * 60_000
/** The longest one stream stays open. */
export const STREAM_MAX_MS = 15 * 60_000
/** How long one poll of a stream waits for the ask to change. */
const STREAM_POLL_SECONDS = 10

/** Runs one ask operation as a person; the dispatcher, or a spec's stand-in. */
export type AskCaller = (name: string, input: OperationInput, session: AuthorizedSession) => Promise<OperationResult>

/**
 * The dispatcher, with the answer read by an agent (`reader: 'agent'`): a
 * route's refusal reaches the A2A client in English, as it does on the MCP door.
 * The A2A caller is an outside agent, so it reaches what `exposure.config.ts`
 * offers one, as on `/api/mcp`.
 */
export const callAskOperation: AskCaller = (name, input, session) => {
  const op = findOperation(name)
  if (!op) throw new Error(`the operation ${name} is not in the catalog`)
  if (!isExposedTo('external', op.name)) throw new Error(`the operation ${name} is not offered to an outside agent`)
  return callOperation(op, input, session, 'agent')
}

/** The route's own words for a refusal: its error envelope's `error`, else the status. */
function routeMessage(result: OperationResult): string {
  const body = result.body
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error: unknown }).error
    if (typeof error === 'string' && error.trim()) return error
  }
  return `Piloti refused the request (${result.status}).`
}

/** A route's refusal as the A2A error that names it; anything else is the SDK's internal error with the route's words. */
function refusal(result: OperationResult, notFound: 'task' | 'malformed'): Error {
  const message = routeMessage(result)
  if (result.status === 404) return notFound === 'task' ? new TaskNotFoundError(message) : new RequestMalformedError(message)
  if (result.status === 400 || result.status === 422) return new RequestMalformedError(message)
  return new Error(message)
}

function viewOf(result: OperationResult, notFound: 'task' | 'malformed'): AskView {
  if (!result.ok) throw refusal(result, notFound)
  return result.body as AskView
}

const statusUpdate = (view: AskView): StreamResponse => {
  const task = taskOf(view)
  return {
    payload: {
      $case: 'statusUpdate',
      value: { taskId: task.id, contextId: task.contextId, status: task.status, metadata: undefined },
    },
  }
}

function* artifactUpdates(view: AskView): Generator<StreamResponse> {
  for (const artifact of artifactsOf(view)) {
    yield {
      payload: {
        $case: 'artifactUpdate',
        value: { taskId: view.id, contextId: view.conversationId, artifact, append: false, lastChunk: true, metadata: undefined },
      },
    }
  }
}

export class PilotiA2ARequestHandler implements A2ARequestHandler {
  private readonly session: AuthorizedSession

  constructor(
    private readonly principal: AgentPrincipal,
    private readonly card: AgentCard,
    private readonly call: AskCaller = callAskOperation,
  ) {
    this.session = principal.session
  }

  /**
   * One ask operation. The call an A2A method makes for its client is recorded
   * as every call on the agent door is: PostHog's `agent_operation_called` and
   * a Langfuse `agent-tool-call` trace, door `a2a`. The polls a blocking call or
   * a stream makes while it waits are not (`recorded: false`): they are the
   * same call, waiting.
   */
  private async run(name: string, input: OperationInput, recorded = true): Promise<OperationResult> {
    if (!recorded) return this.call(name, input, this.session)
    const startedAt = Date.now()
    const record = (status: number) =>
      recordOperationCalled(
        { principal: this.principal, mode: null, door: 'a2a' },
        { operation: name, domain: 'conversations', decision: 'run', status, startedAt },
      )
    try {
      const result = await this.call(name, input, this.session)
      record(result.status)
      return result
    } catch (error) {
      record(500)
      throw error
    }
  }

  async getAgentCard(): Promise<AgentCard> {
    return this.card
  }

  async getAuthenticatedExtendedAgentCard(_params: GetExtendedAgentCardRequest): Promise<AgentCard> {
    throw new ExtendedAgentCardNotConfiguredError('Piloti has one agent card, the public one.')
  }

  /**
   * Ask, waiting as long as the method does: not at all for a non-blocking
   * call (`returnImmediately`, or 0.3's `blocking: false`). A `contextId` that
   * names no conversation an ask of this person started is one the client made
   * up for a new conversation: the ask then starts one, whose id the task
   * carries as its `contextId`.
   */
  private async ask(params: SendMessageRequest, waitSeconds?: number): Promise<AskView> {
    const input = askInputOf(params.message, params.metadata)
    const body = waitSeconds === undefined ? input : { ...input, waitSeconds }
    const result = await this.run('piloti-ask-create', { body })
    if (result.status === 404 && body.conversationId) {
      const { conversationId: _unknown, ...fresh } = body
      return viewOf(await this.run('piloti-ask-create', { body: fresh }), 'malformed')
    }
    return viewOf(result, 'malformed')
  }

  private async read(id: string, waitSeconds: number, recorded = true): Promise<AskView> {
    const query = waitSeconds > 0 ? { waitSeconds } : {}
    return viewOf(await this.run('piloti-ask-get', { params: { id }, query }, recorded), 'task')
  }

  /** Poll until the ask ends or `deadline` passes; the last view. */
  private async settle(view: AskView, deadline: number): Promise<AskView> {
    let current = view
    while (!isTerminalAskState(current.state) && Date.now() < deadline) {
      const left = Math.ceil((deadline - Date.now()) / 1_000)
      current = await this.read(current.id, Math.max(1, Math.min(ASK_WAIT_SECONDS, left)), false)
    }
    return current
  }

  async sendMessage(params: SendMessageRequest): Promise<Message | Task> {
    const started = Date.now()
    const immediately = params.configuration?.returnImmediately === true
    const view = await this.ask(params, immediately ? 0 : undefined)
    const historyLength = params.configuration?.historyLength
    if (immediately) return taskOf(view, historyLength)
    return taskOf(await this.settle(view, started + BLOCKING_MAX_MS), historyLength)
  }

  /** The stream of a task from `view` on: each change of state, then the artifacts and the final state. */
  private async *follow(first: AskView): AsyncGenerator<StreamResponse, void, undefined> {
    const deadline = Date.now() + STREAM_MAX_MS
    let view = first
    let lastState = view.state
    while (!isTerminalAskState(view.state) && Date.now() < deadline) {
      view = await this.read(view.id, STREAM_POLL_SECONDS, false)
      if (view.state !== lastState && !isTerminalAskState(view.state)) yield statusUpdate(view)
      lastState = view.state
    }
    if (!isTerminalAskState(view.state)) return
    yield* artifactUpdates(view)
    yield statusUpdate(view)
  }

  async *sendMessageStream(params: SendMessageRequest): AsyncGenerator<StreamResponse, void, undefined> {
    // A stream opens with the task (specification 3.2.3), so it does not wait for the answer first.
    const view = await this.ask(params, 0)
    if (isTerminalAskState(view.state)) {
      // Ended already (refused, or answered at once): the task whole is the stream, with its artifacts.
      yield { payload: { $case: 'task', value: taskOf(view) } }
      return
    }
    yield { payload: { $case: 'task', value: taskOf(view) } }
    yield* this.follow(view)
  }

  async getTask(params: GetTaskRequest): Promise<Task> {
    return taskOf(await this.read(params.id, 0), params.historyLength)
  }

  async cancelTask(params: CancelTaskRequest): Promise<Task> {
    const result = await this.run('piloti-ask-cancel', { params: { id: params.id } })
    if (result.status === 409) throw new TaskNotCancelableError(routeMessage(result))
    return taskOf(viewOf(result, 'task'))
  }

  async *resubscribe(params: SubscribeToTaskRequest): AsyncGenerator<StreamResponse, void, undefined> {
    const view = await this.read(params.id, 0)
    if (isTerminalAskState(view.state)) {
      throw new UnsupportedOperationError('The task has ended; read it with GetTask.')
    }
    yield { payload: { $case: 'task', value: taskOf(view) } }
    yield* this.follow(view)
  }

  async listTasks(_params: ListTasksRequest): Promise<ListTasksResponse> {
    throw new UnsupportedOperationError('Piloti does not list tasks. Read one with GetTask.')
  }

  async createTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> {
    throw new PushNotificationNotSupportedError('Piloti sends no push notifications; stream or poll instead.')
  }

  async getTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> {
    throw new PushNotificationNotSupportedError('Piloti sends no push notifications; stream or poll instead.')
  }

  async listTaskPushNotificationConfigs(): Promise<ListTaskPushNotificationConfigsResponse> {
    throw new PushNotificationNotSupportedError('Piloti sends no push notifications; stream or poll instead.')
  }

  async deleteTaskPushNotificationConfig(): Promise<void> {
    throw new PushNotificationNotSupportedError('Piloti sends no push notifications; stream or poll instead.')
  }
}
