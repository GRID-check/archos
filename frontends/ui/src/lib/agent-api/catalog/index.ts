/**
 * Every operation Piloti's MCP server offers (ADR-0121): one list, built from
 * one file per domain so the domains grow without touching each other.
 *
 * `agent-reachability.spec.ts` holds this list to the routes: every route a
 * person can call is here, or exempt with a reason.
 */

import { AGENT_DOMAINS, type AgentOperation } from '../operation'
import { bimOperations } from './bim'
import { collaborationOperations } from './collaboration'
import { conversationsOperations } from './conversations'
import { documentsOperations } from './documents'
import { foldersOperations } from './folders'
import { knowledgeOperations } from './knowledge'
import { organizationOperations } from './organization'
import { platformOperations } from './platform'
import { projectsOperations } from './projects'
import { reviewOperations } from './review'
import { skillsOperations } from './skills'
import { tasksOperations } from './tasks'

const unordered: readonly AgentOperation[] = [
  ...projectsOperations,
  ...documentsOperations,
  ...foldersOperations,
  ...reviewOperations,
  ...conversationsOperations,
  ...collaborationOperations,
  ...tasksOperations,
  ...skillsOperations,
  ...knowledgeOperations,
  ...bimOperations,
  ...organizationOperations,
  ...platformOperations,
]

/**
 * Domain order, then name: `tools/list` SHOULD answer in a deterministic order
 * (MCP 2026-07-28), and a stable order keeps a client's prompt cache warm.
 */
export const AGENT_OPERATIONS: readonly AgentOperation[] = [...unordered].sort(
  (a, b) =>
    AGENT_DOMAINS.indexOf(a.domain) - AGENT_DOMAINS.indexOf(b.domain) || a.name.localeCompare(b.name),
)

const byName = new Map(AGENT_OPERATIONS.map((op) => [op.name, op]))

/**
 * Old operation names, each to the name that replaced it, accepted for one release (October 2026, the
 * agent-surface terminology pass: one English word per concept, `task` for a task definition and
 * `task run` for one attempt, `allow` for a held upload). Two readers still hold old names: an
 * `operation` proposal filed before the rename (its payload names the operation) and an agent that
 * remembers a name from an earlier conversation. Neither is listed or searchable under the old name.
 * Delete this map in the release after.
 */
export const RENAMED_OPERATIONS: Readonly<Record<string, string>> = {
  'job-list': 'task-list',
  'job-get': 'task-get',
  'job-create': 'task-create',
  'job-update': 'task-update',
  'job-delete': 'task-delete',
  'job-run': 'task-run-start',
  'job-run-list': 'task-run-list',
  'task-review': 'task-run-review',
  'run-commission': 'task-run-commission',
  'run-get': 'task-run-get',
  'run-cancel': 'task-run-cancel',
  'run-document-add': 'task-run-document-add',
  'run-write-now': 'task-run-write-now',
  'document-quarantine-release': 'document-quarantine-allow',
  'document-quarantine-release-request': 'document-quarantine-allow-request',
}

/**
 * The operation `name` names, by its current name or a {@link RENAMED_OPERATIONS} one. `task-list` was
 * the project's task runs before the rename and is the project's tasks after it; an old proposal for it
 * cannot exist (it only reads), so the one ambiguous name resolves to its new meaning.
 */
export function findOperation(name: string): AgentOperation | undefined {
  return byName.get(name) ?? byName.get(RENAMED_OPERATIONS[name] ?? '')
}
