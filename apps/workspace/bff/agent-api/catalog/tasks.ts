/**
 * The tasks operations (ADR-0122). See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for the
 * rules. A task is the standing definition (`/api/projects/[id]/tasks`), a task run one attempt at it
 * (`/api/projects/[id]/runs`): ADR-0131, rule 1. The wire is `lib/tasks/task-wire.ts`.
 */

import { z } from 'zod'
import { createJobSchema, patchJobSchema } from '@/lib/jobs/types'
import { commissionRunSchema } from '@/lib/runs/commission-wire'
import { planDocumentSchema } from '@/lib/runs/plan-documents'
import {
  RUN_REPORT_MAX_CHARS,
  runViewQuerySchema,
  TASK_PAGE_MAX_LIMIT,
  taskListQuerySchema,
  taskRunListQuerySchema,
} from '@/lib/tasks/task-wire'
import { reviewTaskSchema } from '@/lib/tasks/types'
import type { AgentOperation } from '../operation'
import { PRODUCT_NAME } from '@/lib/brand'

const projectParams = z.object({ id: z.string().describe('The project id, from project-list.') })

const taskParams = projectParams.extend({
  taskId: z.string().describe('The task id, from task-list.'),
})

const runParams = projectParams.extend({
  runId: z.string().describe('The task run id, from project-task-run-list.'),
})

export const tasksOperations = [
  {
    name: 'task-list',
    domain: 'tasks',
    summary: 'List a project’s tasks',
    description:
      'A project’s tasks, newest first: scheduled, one-shot or manual prompts ' + PRODUCT_NAME + ' runs, with schedule and ' +
      `next run. Answers \`{ tasks, nextCursor }\`, at most ${TASK_PAGE_MAX_LIMIT} a page; pass \`nextCursor\` as ` +
      '`cursor` for the next.',
    method: 'GET',
    path: '/api/projects/[id]/tasks',
    params: projectParams,
    query: taskListQuerySchema,
    load: () => import('@/app/api/projects/[id]/tasks/route'),
  },
  {
    name: 'task-get',
    domain: 'tasks',
    summary: 'Read one task',
    description:
      'One task: name, prompt, skill, data sources, schedule or due time, enabled flag, next run. Its runs: ' +
      'project-task-run-list with `taskId`.',
    method: 'GET',
    path: '/api/projects/[id]/tasks/[taskId]',
    params: taskParams,
    load: () => import('@/app/api/projects/[id]/tasks/[taskId]/route'),
  },
  {
    name: 'task-create',
    domain: 'tasks',
    summary: 'Create a standing or one-off task',
    description:
      'Create a task: name, prompt, optional skill and data sources, and a 5-field cron with an IANA timezone or ' +
      'a one-time `dueAt` (neither: it runs only by task-run-start). Each run files a report. Answers `{ task }`.',
    method: 'POST',
    path: '/api/projects/[id]/tasks',
    params: projectParams,
    body: createJobSchema,
    load: () => import('@/app/api/projects/[id]/tasks/route'),
  },
  {
    name: 'task-update',
    domain: 'tasks',
    summary: 'Change a task',
    description:
      'Patch a task’s name, prompt, skill, data sources, schedule, due time or `enabled` (false pauses it).',
    method: 'PATCH',
    path: '/api/projects/[id]/tasks/[taskId]',
    params: taskParams,
    body: patchJobSchema,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/tasks/[taskId]/route'),
  },
  {
    name: 'task-delete',
    domain: 'tasks',
    summary: 'Delete a task',
    description:
      'Permanently delete a task; its runs stay, with `taskId` null. To pause it, task-update `enabled: false`.',
    method: 'DELETE',
    path: '/api/projects/[id]/tasks/[taskId]',
    params: taskParams,
    destructive: true,
    load: () => import('@/app/api/projects/[id]/tasks/[taskId]/route'),
  },
  {
    name: 'task-run-start',
    domain: 'tasks',
    links: 'task-run',
    summary: 'Run a task now',
    description:
      'Run a task now. 409 when it is disabled; at capacity the run is `skipped`, the reason in `error`. ' +
      'Answers `{ run }`; poll task-run-get.',
    method: 'POST',
    path: '/api/projects/[id]/tasks/[taskId]/run',
    params: taskParams,
    load: () => import('@/app/api/projects/[id]/tasks/[taskId]/run/route'),
  },
  {
    name: 'project-task-run-list',
    domain: 'tasks',
    links: 'task-run',
    summary: 'List the task runs of a project',
    description:
      'A project’s task runs, newest first, with status, `taskId`, review and filed document. Filter by ' +
      '`taskId`, `status`, `review` (`none`: awaiting task-run-review). Answers `{ runs, nextCursor }`, at most ' +
      `${TASK_PAGE_MAX_LIMIT} a page; pass \`nextCursor\` as \`cursor\` for the next.`,
    method: 'GET',
    path: '/api/projects/[id]/runs',
    params: projectParams,
    query: taskRunListQuerySchema,
    load: () => import('@/app/api/projects/[id]/runs/route'),
  },
  {
    name: 'task-run-review',
    domain: 'tasks',
    links: 'task-run',
    summary: 'Accept or reject a finished task run',
    description:
      'Accept or reject a finished run (`decision`); a rejection’s `reason` is told to the task’s next run. ' +
      'Judge its `report` from task-run-get. Answers `{ run }`.',
    method: 'POST',
    path: '/api/projects/[id]/runs/[runId]/review',
    params: runParams,
    body: reviewTaskSchema,
    load: () => import('@/app/api/projects/[id]/runs/[runId]/review/route'),
  },
  {
    name: 'task-run-commission',
    domain: 'tasks',
    links: 'task-run',
    summary: 'Commission a research run',
    description:
      'Start a deep research run in a project conversation (`conversationId`, conversation-list): `question`, ' +
      'optional `context` and `documents` ({ basis, excluded } document names). Answers `{ runId, ' +
      'runMessageId, conversationId, status }`; poll task-run-get.',
    method: 'POST',
    path: '/api/projects/[id]/runs',
    params: projectParams,
    body: commissionRunSchema,
    load: () => import('@/app/api/projects/[id]/runs/route'),
  },
  {
    name: 'task-run-get',
    domain: 'tasks',
    links: 'task-run',
    summary: 'Read one task run and what it produced',
    description:
      'One task run: status, `taskId`, its message, ledger (phase, documents read) and `report`: `text` (first ' +
      `${RUN_REPORT_MAX_CHARS} chars, \`truncated\` when cut; null while running or if its conversation is ` +
      'closed to you) and `filedDocumentId` (document-get).',
    method: 'GET',
    path: '/api/projects/[id]/runs/[runId]',
    params: runParams,
    query: runViewQuerySchema,
    load: () => import('@/app/api/projects/[id]/runs/[runId]/route'),
  },
  {
    name: 'task-run-cancel',
    domain: 'tasks',
    links: 'task-run',
    summary: 'Stop a running task run',
    description:
      'Stop a running run; 409 when it can no longer stop. Answers the run view; the ledger turns `cancelled` ' +
      'later (task-run-get).',
    method: 'POST',
    path: '/api/projects/[id]/runs/[runId]/cancel',
    params: runParams,
    destructive: true,
    load: () => import('@/app/api/projects/[id]/runs/[runId]/cancel/route'),
  },
  {
    name: 'task-run-document-add',
    domain: 'tasks',
    summary: 'Add a document to a running run’s basis',
    description:
      'Give a running run one more document to read in full (`name` as listed, optional `title`, `shelf`). ' +
      'Restricted-folder documents are refused. Answers the run view.',
    method: 'POST',
    path: '/api/projects/[id]/runs/[runId]/documents',
    params: runParams,
    body: planDocumentSchema,
    load: () => import('@/app/api/projects/[id]/runs/[runId]/documents/route'),
  },
  {
    name: 'task-run-write-now',
    domain: 'tasks',
    summary: 'Tell a task run to write its report now',
    description:
      'Make a research run stop gathering and write its report now. Answers the run view; task-run-get shows ' +
      'the report.',
    method: 'POST',
    path: '/api/projects/[id]/runs/[runId]/write-now',
    params: runParams,
    load: () => import('@/app/api/projects/[id]/runs/[runId]/write-now/route'),
  },
] as const satisfies readonly AgentOperation[]
