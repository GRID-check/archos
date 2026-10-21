/**
 * An ask as an A2A task, and an A2A message as an ask (ADR-0123). Pure.
 *
 * | A2A | Piloti |
 * |---|---|
 * | Task `id` | the ask's id (`piloti_asks.id`, also the turn id) |
 * | `contextId` | the conversation the ask ran in |
 * | `TaskState` | the ask's `state`, the same words (`ASK_STATES`) |
 * | Message (role user) | the question, the person's message in the thread |
 * | Message (role agent) | Piloti's answer, its message in the thread |
 * | Artifact `answer` | the answer's text, artifact id = the answer's message id |
 * | Artifact per document | a document Piloti filed while answering, as data naming it |
 *
 * `metadata.projectId` on the incoming message names the project, because A2A
 * has no field for it.
 */

import { type Artifact, type Message, type Part, Role, type Task, TaskState } from '@a2a-js/sdk'
import {
  ContentTypeNotSupportedError,
  RequestMalformedError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors'
import type { AskDocument, AskState, AskView, CreateAskRequest } from '@/lib/piloti-asks/ask-wire'

export const TASK_STATE_OF: Readonly<Record<AskState, TaskState>> = {
  submitted: TaskState.TASK_STATE_SUBMITTED,
  working: TaskState.TASK_STATE_WORKING,
  completed: TaskState.TASK_STATE_COMPLETED,
  canceled: TaskState.TASK_STATE_CANCELED,
  failed: TaskState.TASK_STATE_FAILED,
  rejected: TaskState.TASK_STATE_REJECTED,
}

/** The artifact name of the answer's text. */
export const ANSWER_ARTIFACT_NAME = 'answer'

const textPart = (text: string): Part => ({
  content: { $case: 'text', value: text },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
})

function message(view: AskView, role: Role, messageId: string, text: string): Message {
  return {
    messageId,
    contextId: view.conversationId,
    taskId: view.id,
    role,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function documentArtifact(document: AskDocument): Artifact {
  return {
    artifactId: document.versionId,
    name: document.name,
    description: 'A document Piloti filed while answering. Read it with the agent door (document-get, document-download).',
    parts: [
      {
        content: {
          $case: 'data',
          value: { documentId: document.documentId, versionId: document.versionId, projectId: document.projectId },
        },
        metadata: undefined,
        filename: document.name,
        mediaType: 'application/json',
      },
    ],
    metadata: document.contentType ? { contentType: document.contentType } : undefined,
    extensions: [],
  }
}

/** The task's artifacts: the answer's text once there, then each document Piloti filed. */
export function artifactsOf(view: AskView): Artifact[] {
  const answer: Artifact[] = view.answer
    ? [
        {
          artifactId: view.answer.messageId,
          name: ANSWER_ARTIFACT_NAME,
          description: 'Piloti’s answer.',
          parts: [textPart(view.answer.text)],
          metadata: undefined,
          extensions: [],
        },
      ]
    : []
  return [...answer, ...view.documents.map(documentArtifact)]
}

/** The ask as an A2A task. `historyLength` 0 leaves the history out, as the specification asks. */
export function taskOf(view: AskView, historyLength?: number): Task {
  const history: Message[] = []
  if (view.question !== null) history.push(message(view, Role.ROLE_USER, view.id, view.question))
  if (view.answer) history.push(message(view, Role.ROLE_AGENT, view.answer.messageId, view.answer.text))
  const why = view.reason ? message(view, Role.ROLE_AGENT, `${view.id}:status`, view.reason) : undefined
  return {
    id: view.id,
    contextId: view.conversationId,
    status: { state: TASK_STATE_OF[view.state], message: why, timestamp: view.updatedAt },
    artifacts: artifactsOf(view),
    history: historyLength === undefined ? history : history.slice(Math.max(0, history.length - historyLength)),
    metadata: { projectId: view.projectId, pollAfterSeconds: view.pollAfterSeconds },
  }
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/**
 * The ask an incoming A2A message makes. Refuses what the ask cannot carry: no
 * text, a part that is not text (Piloti reads files from the workspace, not from
 * the message), a message from the agent's side, or one that continues a task
 * (`taskId`): an ask never waits for input, so there is no task to continue.
 */
export function askInputOf(incoming: Message | undefined, metadata?: Record<string, unknown>): CreateAskRequest {
  if (!incoming) throw new RequestMalformedError('The request carries no message.')
  if (incoming.role === Role.ROLE_AGENT) throw new RequestMalformedError('Send the question as role user.')
  if (incoming.taskId) {
    throw new UnsupportedOperationError(
      'Piloti never waits for input on a task. Send a new message with the same contextId to follow up.',
    )
  }
  const texts: string[] = []
  for (const part of incoming.parts) {
    if (part.content?.$case !== 'text') {
      throw new ContentTypeNotSupportedError(
        'Piloti reads text. Put files into the workspace with the agent door and name them in the question.',
      )
    }
    texts.push(part.content.value)
  }
  const question = texts.join('\n\n').trim()
  if (!question) throw new RequestMalformedError('The message has no text.')
  const projectId = incoming.metadata?.projectId ?? metadata?.projectId
  return {
    question,
    ...(isString(projectId) ? { projectId } : {}),
    ...(incoming.contextId ? { conversationId: incoming.contextId } : {}),
  }
}
