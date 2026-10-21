/** The tasks operations (ADR-0121). See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for the rules. */

import { z } from 'zod'
import { createJobSchema, listRunsQuerySchema, patchJobSchema } from '@/lib/jobs/types'
import { commissionRunSchema } from '@/lib/runs/commission-wire'
import { planDocumentSchema } from '@/lib/runs/plan-documents'
import { reviewTaskSchema } from '@/lib/tasks/types'
import type { AgentOperation } from '../operation'

const projectParams = z.object({ id: z.string().describe('The project id, from project-list.') })

const jobParams = projectParams.extend({
  jobId: z.string().describe('The job id, from job-list.'),
})

const runParams = projectParams.extend({
  runId: z
    .string()
    .describe('The run id (the public key of a run), from run-commission, job-run-list or task-list.'),
})

export const tasksOperations: readonly AgentOperation[] = [
  {
    name: 'job-list',
    domain: 'tasks',
    summary: 'List a project’s standing jobs',
    description:
      'The jobs of one project: scheduled or one-off prompts Piloti runs as a research run that files a report, ' +
      'with their schedule, attached skill and next run. Needs the skills feature on. ' +
      'Take a job id from here for job-get, job-update, job-delete, job-run and job-run-list.',
    method: 'GET',
    path: '/api/projects/[id]/jobs',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/jobs/route'),
  },
  {
    name: 'job-get',
    domain: 'tasks',
    summary: 'Read one job',
    description:
      'One job by id: name, prompt, attached skill, data sources, schedule (cron and timezone, or a due time), ' +
      'enabled flag and next run. For what it produced, call job-run-list.',
    method: 'GET',
    path: '/api/projects/[id]/jobs/[jobId]',
    params: jobParams,
    load: () => import('@/app/api/projects/[id]/jobs/[jobId]/route'),
  },
  {
    name: 'job-create',
    domain: 'tasks',
    summary: 'Create a standing or one-off job',
    description:
      'Create a job in a project: a name, a prompt, optionally an attached skill (skill-list), data sources and ' +
      'either a 5-field cron schedule with an IANA timezone or a one-time `dueAt` (not both; neither means it runs ' +
      'only by hand with job-run). Needs project:skills:manage. Returns `{ job }` with its id.',
    method: 'POST',
    path: '/api/projects/[id]/jobs',
    params: projectParams,
    body: createJobSchema,
    load: () => import('@/app/api/projects/[id]/jobs/route'),
  },
  {
    name: 'job-update',
    domain: 'tasks',
    summary: 'Change a job',
    description:
      'Patch any of a job’s name, prompt, attached skill, data sources, enabled flag, schedule or due time. ' +
      'Changing the skill re-resolves it and changing the schedule recomputes the next run. ' +
      'Set `enabled: false` to pause a job without deleting it. Needs project:skills:manage.',
    method: 'PATCH',
    path: '/api/projects/[id]/jobs/[jobId]',
    params: jobParams,
    body: patchJobSchema,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/jobs/[jobId]/route'),
  },
  {
    name: 'job-delete',
    domain: 'tasks',
    summary: 'Delete a job',
    description:
      'Delete a job and stop its schedule. Needs project:skills:manage. To keep the job but stop it firing, ' +
      'call job-update with `enabled: false` instead.',
    method: 'DELETE',
    path: '/api/projects/[id]/jobs/[jobId]',
    params: jobParams,
    load: () => import('@/app/api/projects/[id]/jobs/[jobId]/route'),
  },
  {
    name: 'job-run',
    domain: 'tasks',
    summary: 'Run a job now',
    description:
      'Fire a job immediately, outside its schedule ("Run now"). Fails with 409 when the job is disabled; when the ' +
      'backend is at capacity the run comes back as `skipped` rather than failing. Needs project:skills:manage. ' +
      'Follow the result with run-get using the run id it returns.',
    method: 'POST',
    path: '/api/projects/[id]/jobs/[jobId]/run',
    params: jobParams,
    load: () => import('@/app/api/projects/[id]/jobs/[jobId]/run/route'),
  },
  {
    name: 'job-run-list',
    domain: 'tasks',
    summary: 'List the runs of a job',
    description:
      'The submission history of one job, newest first, paginated with `limit` (1 to 200, default 50) and ' +
      '`offset`. Use it to see whether a scheduled job fired and how each run ended.',
    method: 'GET',
    path: '/api/projects/[id]/jobs/[jobId]/runs',
    params: jobParams,
    query: listRunsQuerySchema,
    load: () => import('@/app/api/projects/[id]/jobs/[jobId]/runs/route'),
  },
  {
    name: 'task-list',
    domain: 'tasks',
    summary: 'List a project’s delegated tasks',
    description:
      'The project’s delegated work, newest first: each task with its status, the job it came from and its review ' +
      'state. Needs the skills and task-automation features on. A finished task awaits task-review.',
    method: 'GET',
    path: '/api/projects/[id]/tasks',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/tasks/route'),
  },
  {
    name: 'task-review',
    domain: 'tasks',
    summary: 'Accept or reject a finished task',
    description:
      'Record a person’s verdict on a finished task: `decision` accepts or rejects it, and a rejection can carry a ' +
      '`reason` that the next run of the same job is told. Needs project:edit. Task ids come from task-list. ' +
      'Returns `{ task }`.',
    method: 'POST',
    path: '/api/projects/[id]/tasks/[taskId]/review',
    params: projectParams.extend({ taskId: z.string().describe('The task id, from task-list.') }),
    body: reviewTaskSchema,
    load: () => import('@/app/api/projects/[id]/tasks/[taskId]/review/route'),
  },
  {
    name: 'run-commission',
    domain: 'tasks',
    summary: 'Commission a research run',
    description:
      'Start a deep research run for a question inside an existing conversation of the project: ' +
      '`conversationId` (from conversation-list), `question`, optional `context` and optional `documents` ' +
      '({ basis, excluded } lists of document names) to carry forward. Needs the deep-research feature and ' +
      'collaborator access to the conversation. Returns `{ runId, runMessageId, conversationId, status }`; ' +
      'follow it with run-get.',
    method: 'POST',
    path: '/api/projects/[id]/runs',
    params: projectParams,
    body: commissionRunSchema,
    load: () => import('@/app/api/projects/[id]/runs/route'),
  },
  {
    name: 'run-get',
    domain: 'tasks',
    summary: 'Read one run',
    description:
      'One run by its public id: where its message sits in the conversation and what its ledger says (phase, ' +
      'status, the documents it reads). Poll it after run-commission or job-run. Needs project:view.',
    method: 'GET',
    path: '/api/projects/[id]/runs/[runId]',
    params: runParams,
    load: () => import('@/app/api/projects/[id]/runs/[runId]/route'),
  },
  {
    name: 'run-cancel',
    domain: 'tasks',
    summary: 'Stop a running run',
    description:
      'Ask the backend to stop one run. Refuses with 409 when the run can no longer be stopped. Returns the run ' +
      'view as it stands; the ledger turns `cancelled` afterwards, so read it again with run-get.',
    method: 'POST',
    path: '/api/projects/[id]/runs/[runId]/cancel',
    params: runParams,
    destructive: true,
    load: () => import('@/app/api/projects/[id]/runs/[runId]/cancel/route'),
  },
  {
    name: 'run-document-add',
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
    name: 'run-write-now',
    domain: 'tasks',
    summary: 'Tell a run to write its report now',
    description:
      'Stop a research run gathering sources and make it write the report from what it has ("Jetzt schreiben"). ' +
      'Returns the run view; read it again with run-get to see the report arrive.',
    method: 'POST',
    path: '/api/projects/[id]/runs/[runId]/write-now',
    params: runParams,
    load: () => import('@/app/api/projects/[id]/runs/[runId]/write-now/route'),
  },
]
