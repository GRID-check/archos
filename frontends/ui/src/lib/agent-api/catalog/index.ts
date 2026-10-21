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

export function findOperation(name: string): AgentOperation | undefined {
  return byName.get(name)
}
