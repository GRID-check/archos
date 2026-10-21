/**
 * @vitest-environment node
 */
/**
 * The workspace eval's WORKSPACE block, written by the production renderer
 * (ADR-0122). The fixture office (`tests/fixtures/workspace/office.json`) is
 * the source; this writes the block the real BFF would hand a turn of Lena
 * Berger's in its current project to `tests/fixtures/workspace/rendered.json`,
 * which `scripts/turn_census/fixture_workspace.py` serves with `{conversation}`
 * replaced by the run's conversation. A change to the block fails here until the
 * fixture is regenerated:
 *
 *   UPDATE_FIXTURES=1 npx vitest run src/lib/turn-context/workspace-block.fixture.spec.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type WorkspaceFacts, renderWorkspaceBlock } from './workspace-block'

const DIR = join(process.cwd(), 'tests/fixtures/workspace')

interface FixtureOffice {
  current: string
  projects: { id: string; name: string; status: string }[]
  reads: { 'inbox-list': { items: { read: boolean }[] } }
}

function render(): string {
  const office = JSON.parse(readFileSync(join(DIR, 'office.json'), 'utf8')) as FixtureOffice
  const project = office.projects.find((candidate) => candidate.id === office.current)
  if (!project) throw new Error('office.json names a current project it does not hold')
  const facts: WorkspaceFacts = {
    organizationRole: 'admin',
    projectRole: 'project-admin',
    project,
    // A new conversation of the asker's own: the eval's runs start with none.
    conversation: { id: '{conversation}', audience: 'solo' },
    inboxWaiting: office.reads['inbox-list'].items.filter((item) => !item.read).length,
    activeRuns: 0,
    proposals: [],
    proposalsTruncated: false,
  }
  const workspace = renderWorkspaceBlock(facts)
  // The lines a turn's proposals add, with placeholders, so the fixture lists what a run filed as production would.
  const withOne = renderWorkspaceBlock({
    ...facts,
    proposals: [{ id: '{id}', kind: 'operation', status: 'proposed', summary: '{summary}' }],
  }).split('\n')
  const fixture = {
    comment:
      'Written by src/lib/turn-context/workspace-block.fixture.spec.ts from office.json; served by ' +
      'scripts/turn_census/fixture_workspace.py. Regenerate with UPDATE_FIXTURES=1.',
    workspace,
    proposalsHeader: withOne.at(-2),
    proposalLine: withOne.at(-1),
  }
  return `${JSON.stringify(fixture, null, 1)}\n`
}

describe('the workspace eval’s WORKSPACE block', () => {
  it('is what the production renderer writes for the fixture office', () => {
    const rendered = render()
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(join(DIR, 'rendered.json'), rendered)
    expect(readFileSync(join(DIR, 'rendered.json'), 'utf8')).toBe(rendered)
  })
})
