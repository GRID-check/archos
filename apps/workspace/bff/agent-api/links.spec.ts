/**
 * @vitest-environment node
 */
/**
 * What the door answers carries `url`, the page a person opens, on the objects
 * its operation declares in `links`, and nothing at all without a pinned origin.
 */
import { describe, expect, it } from 'vitest'
import { findOperation } from './catalog'
import { fromOperationResult } from './discovery'
import type { OperationInput } from './dispatch'
import { withLinks } from './links'
import type { AgentOperation } from './operation'

const ORIGIN = 'https://app.piloti.test'

function op(name: string): AgentOperation {
  const found = findOperation(name)
  if (!found) throw new Error(`no operation ${name}`)
  return found
}

const link = (name: string, body: unknown, input: OperationInput = {}) => withLinks(op(name), input, body, ORIGIN)

describe('links on door answers', () => {
  it('gives each project of project-list its page', () => {
    expect(link('project-list', [{ id: 'p1', name: 'Haus Josef' }])).toEqual([
      { id: 'p1', name: 'Haus Josef', url: `${ORIGIN}/app/projects/p1` },
    ])
    expect(link('project-get', { id: 'p1', name: 'Haus Josef' })).toMatchObject({ url: `${ORIGIN}/app/projects/p1` })
  })

  it('opens a listed document in its project’s files, or on the office shelf', () => {
    const page = { documents: [{ id: 'd1', filename: 'EG.pdf' }], nextCursor: null }
    expect(link('document-list', page, { query: { projectId: 'p1' } })).toEqual({
      documents: [{ id: 'd1', filename: 'EG.pdf', url: `${ORIGIN}/app/projects/p1/files?doc=d1` }],
      nextCursor: null,
    })
    expect(link('document-list', page, { query: { scope: 'office_shelf' } })).toMatchObject({
      documents: [{ url: `${ORIGIN}/app/office-shelf?doc=d1` }],
    })
  })

  it('opens document-get’s document in the project the answer names', () => {
    expect(link('document-get', { document: { id: 'd1', projectId: 'p1' } }, { params: { id: 'd1' } })).toEqual({
      document: { id: 'd1', projectId: 'p1', url: `${ORIGIN}/app/projects/p1/files?doc=d1` },
    })
    expect(link('document-get', { document: { id: 'd1', projectId: null } })).toMatchObject({
      document: { url: `${ORIGIN}/app/office-shelf?doc=d1` },
    })
  })

  it('opens a task run at its block in its thread, the project taken from the path', () => {
    const input = { params: { id: 'p1', runId: 'r1' } }
    expect(link('task-run-get', { runId: 'r1', taskId: 't1', conversationId: 's_1', status: 'running' }, input)).toMatchObject({
      url: `${ORIGIN}/app/projects/p1/chat?session=s_1&run=r1`,
    })
    const runs = { runs: [{ id: 'r2', taskId: 't1', conversationId: null }], nextCursor: null }
    expect(link('project-task-run-list', runs, { params: { id: 'p1' } })).toMatchObject({
      runs: [{ url: `${ORIGIN}/app/projects/p1/automation?tab=tasks&task=t1` }],
    })
    expect(link('task-run-start', { run: { id: 'r3', conversationId: 's_3' } }, { params: { id: 'p1', taskId: 't1' } })).toMatchObject({
      run: { url: `${ORIGIN}/app/projects/p1/chat?session=s_3&run=r3` },
    })
  })

  it('links an ask to its conversation, and leaves the documents it filed alone', () => {
    const view = { id: 'ask-1', conversationId: 's_9', projectId: 'p1', state: 'completed', documents: [{ id: 'd1' }] }
    expect(link('agent-ask-create', view)).toEqual({ ...view, url: `${ORIGIN}/app/projects/p1/chat?session=s_9` })
    expect(link('conversation-list', { conversations: [{ id: 's_2', projectId: null }], nextCursor: null })).toMatchObject({
      conversations: [{ url: `${ORIGIN}/app/chat?session=s_2` }],
    })
  })

  it('keeps a url the answer already has, and adds none where the operation declares no links', () => {
    expect(link('project-get', { id: 'p1', url: 'https://elsewhere.test' })).toEqual({ id: 'p1', url: 'https://elsewhere.test' })
    const members = { members: [{ id: 'm1' }] }
    expect(link('project-member-list', members, { params: { id: 'p1' } })).toBe(members)
  })

  it('adds no url when the deployment pins no origin', () => {
    const rows = [{ id: 'p1' }]
    expect(withLinks(op('project-list'), {}, rows, null)).toBe(rows)
  })

  it('reaches the tool result, structured content and text alike, and only with an origin', () => {
    const result = { status: 200, ok: true, body: { runId: 'r1', conversationId: 's_1' } }
    const input = { params: { id: 'p1', runId: 'r1' } }
    const linked = fromOperationResult(op('task-run-get'), result, input, ORIGIN)
    expect(linked.structuredContent).toMatchObject({ url: `${ORIGIN}/app/projects/p1/chat?session=s_1&run=r1` })
    expect(linked.content[0]).toMatchObject({ text: expect.stringContaining('"url":') })
    const bare = fromOperationResult(op('task-run-get'), result, input, null)
    expect(bare.structuredContent).not.toHaveProperty('url')
  })
})
