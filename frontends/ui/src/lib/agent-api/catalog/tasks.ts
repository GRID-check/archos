/** The tasks operations (ADR-0122). See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for the rules. */

import { z } from 'zod'
import { createJobSchema, listRunsQuerySchema, patchJobSchema } from '@/lib/jobs/types'
import { commissionRunSchema } from '@/lib/runs/commission-wire'
import { planDocumentSchema } from '@/lib/runs/plan-documents'
import { reviewTaskSchema } from '@/lib/tasks/types'
import type { AgentOperation } from '../operation'

const projectParams = z.object({ id: z.string().describe('The project id, from project-list.') })

// The path segment is still `[jobId]` (`/api/projects/[id]/jobs`): `/api/projects/[id]/tasks` already serves the
// project's task runs, so the route keeps its name and only the agent-facing words say "task".
const taskParams = projectParams.extend({
  jobId: z.string().describe('The task id, from task-list.'),
})

const runParams = projectParams.extend({
  runId: z
    .string()
    .describe(
      'The task run id (the public key of a run), from task-run-commission, task-run-start, task-run-list or ' +
        'project-task-run-list.',
    ),
})

export const tasksOperations: readonly AgentOperation[] = [
  {
    name: 'task-list',
    domain: 'tasks',
    summary: 'List a project’s tasks',
    description:
      'The tasks of one project: standing (scheduled) or one-off prompts Piloti carries out as a task run that ' +
      'files a report, with their schedule, attached skill and next run. Needs the skills feature on. ' +
      'Take a task id from here for task-get, task-update, task-delete, task-run-start and task-run-list.',
    method: 'GET',
    path: '/api/projects/[id]/jobs',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/jobs/route'),
  },
  {
    name: 'task-get',
    domain: 'tasks',
    summary: 'Read one task',
    description:
      'One task by id: name, prompt, attached skill, data sources, schedule (cron and timezone, or a due time), ' +
      'enabled flag and next run. For what it produced, call task-run-list.',
    method: 'GET',
    path: '/api/projects/[id]/jobs/[jobId]',
    params: taskParams,
    load: () => import('@/app/api/projects/[id]/jobs/[jobId]/route'),
  },
  {
    name: 'task-create',
    domain: 'tasks',
    summary: 'Create a standing or one-off task',
    description:
      'Create a task in a project: a name, a prompt, optionally an attached skill (skill-list), data sources and ' +
      'either a 5-field cron schedule with an IANA timezone or a one-time `dueAt` (not both; neither means it runs ' +
      'only by hand with task-run-start). Needs project:skills:manage. Returns `{ job }`: the task, with its id.',
    method: 'POST',
    path: '/api/projects/[id]/jobs',
    params: projectParams,
    body: createJobSchema,
    load: () => import('@/app/api/projects/[id]/jobs/route'),
  },
  {
    name: 'task-update',
    domain: 'tasks',
    summary: 'Change a task',
    description:
      'Patch any of a task’s name, prompt, attached skill, data sources, enabled flag, schedule or due time. ' +
      'Changing the skill re-resolves it and changing the schedule recomputes the next run. ' +
      'Set `enabled: false` to pause a task without deleting it. Needs project:skills:manage.',
    method: 'PATCH',
    path: '/api/projects/[id]/jobs/[jobId]',
    params: taskParams,
    body: patchJobSchema,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/jobs/[jobId]/route'),
  },
  {
    name: 'task-delete',
    domain: 'tasks',
    summary: 'Delete a task',
    description:
      'Delete a task and stop its schedule. Needs project:skills:manage. To keep the task but stop it firing, ' +
      'call task-update with `enabled: false` instead.',
    method: 'DELETE',
    path: '/api/projects/[id]/jobs/[jobId]',
    params: taskParams,
    load: () => import('@/app/api/projects/[id]/jobs/[jobId]/route'),
  },
  {
    name: 'task-run-start',
    domain: 'tasks',
    summary: 'Run a task now',
    description:
      'Start a task run immediately, outside the task’s schedule ("Run now"). Fails with 409 when the task is ' +
      'disabled; when the backend is at capacity the run comes back as `skipped` rather than failing. ' +
      'Needs project:skills:manage. Follow the result with task-run-get using the run id it returns.',
    method: 'POST',
    path: '/api/projects/[id]/jobs/[jobId]/run',
    params: taskParams,
    load: () => import('@/app/api/projects/[id]/jobs/[jobId]/run/route'),
  },
  {
    name: 'task-run-list',
    domain: 'tasks',
    summary: 'List the runs of one task',
    description:
      'The run history of one task, newest first, paginated with `limit` (1 to 200, default 50) and ' +
      '`offset`. Use it to see whether a scheduled task fired and how each run ended. For every run in the ' +
      'project with its review state, call project-task-run-list.',
    method: 'GET',
    path: '/api/projects/[id]/jobs/[jobId]/runs',
    params: taskParams,
    query: listRunsQuerySchema,
    load: () => import('@/app/api/projects/[id]/jobs/[jobId]/runs/route'),
  },
  {
    name: 'project-task-run-list',
    domain: 'tasks',
    summary: 'List every task run of a project',
    description:
      'The project’s delegated work, newest first: each task run with its status, the task it came from and its ' +
      'review state. Needs the skills and task-automation features on. A finished run awaits task-run-review.',
    method: 'GET',
    path: '/api/projects/[id]/tasks',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/tasks/route'),
  },
  {
    name: 'task-run-review',
    domain: 'tasks',
    summary: 'Accept or reject a finished task run',
    description:
      'Record a person’s verdict on a finished task run: `decision` accepts or rejects it, and a rejection can ' +
      'carry a `reason` that the next run of the same task is told. Needs project:edit. Run ids come from ' +
      'project-task-run-list. Returns `{ task }`: the task run.',
    method: 'POST',
    path: '/api/projects/[id]/tasks/[taskId]/review',
    params: projectParams.extend({ taskId: z.string().describe('The task run id, from project-task-run-list.') }),
    body: reviewTaskSchema,
    load: () => import('@/app/api/projects/[id]/tasks/[taskId]/review/route'),
  },
  {
    name: 'task-run-commission',
    domain: 'tasks',
    summary: 'Commission a research run',
    description:
      'Start a deep research run for a question inside an existing conversation of the project: ' +
      '`conversationId` (from conversation-list), `question`, optional `context` and optional `documents` ' +
      '({ basis, excluded } lists of document names) to carry forward. Needs the deep-research feature and ' +
      'collaborator access to the conversation. Returns `{ runId, runMessageId, conversationId, status }`; ' +
      'follow it with task-run-get.',
    method: 'POST',
    path: '/api/projects/[id]/runs',
    params: projectParams,
    body: commissionRunSchema,
    load: () => import('@/app/api/projects/[id]/runs/route'),
  },
  {
    name: 'task-run-get',
    domain: 'tasks',
    summary: 'Read one task run',
    description:
      'One run by its public id: where its message sits in the conversation and what its ledger says (phase, ' +
      'status, the documents it reads). Poll it after task-run-commission or task-run-start. Needs project:view.',
    method: 'GET',
    path: '/api/projects/[id]/runs/[runId]',
    params: runParams,
    load: () => import('@/app/api/projects/[id]/runs/[runId]/route'),
  },
  {
    name: 'task-run-cancel',
    domain: 'tasks',
    summary: 'Stop a running task run',
    description:
      'Ask the backend to stop one run. Refuses with 409 when the run can no longer be stopped. Returns the run ' +
      'view as it stands; the ledger turns `cancelled` afterwards, so read it again with task-run-get.',
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
      'Name one more document (`name` as the inventory lists it, optional `title` and `shelf`) for a running run ' +
      'to read in full. Documents from a restricted folder are refused. Returns the run view.',
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
      'Stop a research run gathering sources and make it write the report from what it has (the "Write now" ' +
      'button). Returns the run view; read it again with task-run-get to see the report arrive.',
    method: 'POST',
    path: '/api/projects/[id]/runs/[runId]/write-now',
    params: runParams,
    load: () => import('@/app/api/projects/[id]/runs/[runId]/write-now/route'),
  },
]
