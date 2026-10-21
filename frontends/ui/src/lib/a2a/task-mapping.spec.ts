/**
 * An ask as an A2A task, and an A2A message as an ask (ADR-0122): the mapping
 * table in `task-mapping.ts`, pinned.
 */

import { Role, TaskState, type Message } from '@a2a-js/sdk'
import { describe, expect, it } from 'vitest'
import { ASK_STATES, type AskView } from '@/lib/piloti-asks/ask-wire'
import { askInputOf, taskOf, TASK_STATE_OF } from './task-mapping'

const THREAD = 's_11111111_1111_4111_8111_111111111111'

const view = (over: Partial<AskView> = {}): AskView => ({
  id: 'ask-1',
  conversationId: THREAD,
  projectId: 'project-1',
  state: 'completed',
  question: 'Welche Fluchtweglänge gilt?',
  reason: null,
  answer: { messageId: 'answer-1', text: 'Höchstens 40 m.' },
  documents: [
    { documentId: 'doc-1', versionId: 'ver-1', name: 'Brandschutzkonzept.docx', projectId: 'project-1', contentType: 'application/pdf' },
  ],
  createdAt: '2026-10-21T09:00:00.000Z',
  updatedAt: '2026-10-21T09:00:30.000Z',
  endedAt: '2026-10-21T09:00:30.000Z',
  pollAfterSeconds: null,
  ...over,
})

const message = (over: Partial<Message> = {}): Message => ({
  messageId: 'm-1',
  contextId: '',
  taskId: '',
  role: Role.ROLE_USER,
  parts: [{ content: { $case: 'text', value: 'Welche Fluchtweglänge gilt?' }, metadata: undefined, filename: '', mediaType: '' }],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
  ...over,
})

describe('taskOf', () => {
  it('maps every ask state to the task state of the same word', () => {
    for (const state of ASK_STATES) {
      expect(TaskState[TASK_STATE_OF[state]]).toBe(`TASK_STATE_${state.toUpperCase()}`)
    }
  })

  it('is the ask: id, context, state, the answer and each filed document as artifacts, the exchange as history', () => {
    const task = taskOf(view())
    expect(task).toMatchObject({ id: 'ask-1', contextId: THREAD, status: { state: TaskState.TASK_STATE_COMPLETED } })
    expect(task.artifacts.map((artifact) => [artifact.artifactId, artifact.name])).toEqual([
      ['answer-1', 'answer'],
      ['ver-1', 'Brandschutzkonzept.docx'],
    ])
    expect(task.artifacts[1]?.parts[0]?.content).toEqual({
      $case: 'data',
      value: { documentId: 'doc-1', versionId: 'ver-1', projectId: 'project-1' },
    })
    expect(task.history.map((entry) => entry.role)).toEqual([Role.ROLE_USER, Role.ROLE_AGENT])
    expect(task.metadata).toMatchObject({ projectId: 'project-1' })
  })

  it('says why in the status message of a rejected ask', () => {
    const task = taskOf(view({ state: 'rejected', reason: 'budget: spent', answer: null, documents: [] }))
    expect(task.status?.state).toBe(TaskState.TASK_STATE_REJECTED)
    expect(task.status?.message?.parts[0]?.content).toEqual({ $case: 'text', value: 'budget: spent' })
    expect(task.artifacts).toEqual([])
  })

  it('keeps the last historyLength messages, none for 0', () => {
    expect(taskOf(view(), 0).history).toEqual([])
    expect(taskOf(view(), 1).history.map((entry) => entry.role)).toEqual([Role.ROLE_AGENT])
  })
})

describe('askInputOf', () => {
  it('takes the text, the contextId as the conversation and metadata.projectId as the project', () => {
    expect(askInputOf(message({ contextId: THREAD, metadata: { projectId: 'project-1' } }))).toEqual({
      question: 'Welche Fluchtweglänge gilt?',
      conversationId: THREAD,
      projectId: 'project-1',
    })
  })

  it.each([
    ['no message', undefined, 'RequestMalformedError'],
    ['a message from the agent side', message({ role: Role.ROLE_AGENT }), 'RequestMalformedError'],
    ['a message that continues a task', message({ taskId: 'ask-1' }), 'UnsupportedOperationError'],
    [
      'a file part',
      message({ parts: [{ content: { $case: 'url', value: 'https://x.test/a.pdf' }, metadata: undefined, filename: 'a.pdf', mediaType: 'application/pdf' }] }),
      'ContentTypeNotSupportedError',
    ],
    [
      'only whitespace',
      message({ parts: [{ content: { $case: 'text', value: '  ' }, metadata: undefined, filename: '', mediaType: '' }] }),
      'RequestMalformedError',
    ],
  ])('refuses %s', (_why, incoming, name) => {
    expect(() => askInputOf(incoming)).toThrow(expect.objectContaining({ name }))
  })
})
