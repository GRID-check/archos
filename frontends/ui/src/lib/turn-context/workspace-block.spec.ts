import { describe, expect, it } from 'vitest'
import {
  MAX_WORKSPACE_PROPOSALS,
  type WorkspaceFacts,
  proposalOutcomeOf,
  proposalSummaryOf,
  renderWorkspaceBlock,
} from './workspace-block'

const facts = (overrides: Partial<WorkspaceFacts> = {}): WorkspaceFacts => ({
  organizationRole: 'admin',
  projectRole: 'project-admin',
  project: { id: 'p1', name: 'Wohnhaus Mödling', status: 'active' },
  conversation: { id: 'c1', audience: 'solo' },
  inboxWaiting: 2,
  activeRuns: 1,
  proposals: [],
  proposalsTruncated: false,
  ...overrides,
})

describe('renderWorkspaceBlock', () => {
  it('names the asker, the project, the audience and what waits', () => {
    expect(renderWorkspaceBlock(facts())).toBe(
      [
        `WORKSPACE v1 (the workspace as of this turn; the proposal list is the newest ${MAX_WORKSPACE_PROPOSALS})`,
        'asker: organization role admin · project role project-admin',
        'project: Wohnhaus Mödling · id p1 · active',
        'conversation: c1 · solo (only the asker reads it)',
        'inbox: 2 item(s) wait for the asker',
        'runs: 1 queued or running in this project',
        'proposals made in this conversation: none',
      ].join('\n')
    )
  })

  it('lists every status of this conversation’s proposals, and says when older ones are cut', () => {
    const block = renderWorkspaceBlock(
      facts({
        proposals: [
          { id: 'a', kind: 'operation', status: 'proposed', summary: 'Create a folder (name: Fotos)' },
          { id: 'b', kind: 'operation', status: 'failed', summary: 'Add a member', outcome: 'failed: no access' },
          { id: 'c', kind: 'memory', status: 'applied', summary: 'remember: Statik macht Büro Leitner', outcome: null },
        ],
        proposalsTruncated: true,
      })
    )
    expect(block).toContain('proposals made in this conversation (newest first; older ones not shown):')
    expect(block).toContain('- a · waiting for the person · operation: Create a folder (name: Fotos)')
    expect(block).toContain('- b · failed · operation: Add a member · failed: no access')
    expect(block).toContain('- c · applied · memory: remember: Statik macht Büro Leitner')
  })

  it('leaves out what it could not read instead of guessing it, and tells the agent a shared audience', () => {
    const block = renderWorkspaceBlock(
      facts({ inboxWaiting: null, activeRuns: null, conversation: { id: 'c1', audience: 'shared' } })
    )
    expect(block).not.toContain('inbox:')
    expect(block).not.toContain('runs:')
    expect(block).toContain('shared (others read it, so no workspace read runs here; writes are still proposed)')
  })

  it('clips a long summary to one bounded line', () => {
    const block = renderWorkspaceBlock(
      facts({ proposals: [{ id: 'a', kind: 'operation', status: 'proposed', summary: `x\n${'y'.repeat(500)}` }] })
    )
    const line = block.split('\n').at(-1) ?? ''
    expect(line.length).toBeLessThan(260)
    expect(line).not.toContain('\n')
  })

  it('says when the turn has no project or no conversation', () => {
    const block = renderWorkspaceBlock(facts({ project: null, projectRole: null, conversation: null, activeRuns: null }))
    expect(block).toContain('project: none (the turn runs on the organization)')
    expect(block).toContain('conversation: none (a run outside a chat)')
    expect(block).not.toContain('proposals made')
  })
})

describe('proposalSummaryOf / proposalOutcomeOf', () => {
  it('reads each kind’s payload defensively', () => {
    expect(proposalSummaryOf('operation', { summary: 'Rename a document' })).toBe('Rename a document')
    expect(proposalSummaryOf('memory', { content: 'Holzbau' })).toBe('remember: Holzbau')
    expect(proposalSummaryOf('file_operation', { operation: 'move', operations: [{}, {}] })).toBe('move 2 file(s)')
    expect(proposalSummaryOf('project_profile', null)).toBe('change the project profile')
    expect(proposalSummaryOf('operation', 'garbage')).toBe('operation')
  })

  it('says why a write failed, or what it created', () => {
    expect(proposalOutcomeOf([{ ok: false, reason: 'gone' }, { ok: true, itemId: 'm1' }])).toBe('failed: gone; created m1')
    expect(proposalOutcomeOf(null)).toBeNull()
    expect(proposalOutcomeOf([{ ok: true }])).toBeNull()
  })
})
