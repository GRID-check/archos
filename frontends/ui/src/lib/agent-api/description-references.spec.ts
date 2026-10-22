/**
 * @vitest-environment node
 */
/**
 * A description promises only what the door offers (ADR-0131, rule 8). An
 * operation's description that tells the agent to call another operation is
 * followed literally; when the door withholds that one, the agent's next call
 * is refused and the description sent it there. Scouts met this on the door:
 * `project-create` said to take a geocoder hit from an operation the door
 * withholds.
 *
 * For each audience, every catalog or backend operation name that appears in a
 * description offered to it must itself be offered to it. The baseline lists
 * the references that were wrong when the rule was written; it only shrinks.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { BACKEND_OPERATIONS } from './backend-operations'
import { AGENT_OPERATIONS } from './catalog'
import { type Audience, isExposedTo } from './exposure'

const ALL = [...AGENT_OPERATIONS, ...BACKEND_OPERATIONS]
const NAMES = new Set(ALL.map((op) => op.name))
const AUDIENCES: readonly Audience[] = ['external', 'piloti']

/** `from → to` for each reference an audience is offered but cannot follow. */
function brokenReferences(): string[] {
  const broken = new Set<string>()
  for (const audience of AUDIENCES) {
    for (const op of ALL) {
      if (!isExposedTo(audience, op.name)) continue
      for (const word of op.description.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g) ?? []) {
        if (word === op.name || !NAMES.has(word)) continue
        if (!isExposedTo(audience, word)) broken.add(`${audience}: ${op.name} → ${word}`)
      }
    }
  }
  return [...broken].sort()
}

/**
 * Wrong when ADR-0131 was written. Remove a line when you fix it; never add one. Every one is on
 * Piloti's own door: the description tells Piloti to call an operation it may only propose.
 */
const BASELINE: readonly string[] = [
  'piloti: annotation-list → annotation-reply-create',
  'piloti: annotation-list → annotation-update',
  'piloti: bim-model-get → bim-model-query',
  'piloti: bim-model-list → bim-model-query',
  'piloti: bim-model-source-get → bim-model-query',
  'piloti: conversation-message-changes → piloti-change-undo',
  'piloti: conversation-message-update → proposal-apply',
  'piloti: document-quarantine-get → document-quarantine-allow',
  'piloti: hold-create → hold-release',
  'piloti: hold-list → hold-release',
  'piloti: project-folder-access-get → project-folder-access-set',
  'piloti: project-member-list → project-member-remove',
  'piloti: project-person-add → project-member-add',
  'piloti: proposal-list → proposal-apply',
  'piloti: proposal-list → proposal-dismiss',
  'piloti: sharing-get → sharing-grant-add',
  'piloti: sharing-get → sharing-grant-revoke',
  'piloti: sharing-get → sharing-grant-update',
  'piloti: sharing-get → sharing-visibility-set',
  'piloti: skill-list → task-create',
  'piloti: task-run-get → task-run-commission',
]

describe('descriptions name only operations the door offers', () => {
  it('has no reference beyond the baseline, and the baseline holds no fixed one', () => {
    expect(brokenReferences()).toEqual([...BASELINE].sort())
  })
})
