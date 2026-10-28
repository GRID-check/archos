/**
 * Tasks API client
 *
 * Typed fetch client for a project's tasks (`/api/projects/[id]/tasks…`) and
 * the runs of one task (`/api/projects/[id]/runs?taskId=…`). Same-origin BFF
 * routes; the wire is `lib/tasks/task-wire.ts` (ADR-0131: a task is the
 * definition, a task run one attempt at it).
 *
 * In this feature a task is still called a job (`Job`, `listJobs`): the
 * schedule wizard, card and timetable were written against that name, and the
 * name is this module's, not the wire's.
 *
 * A task's runs always produce the same thing: a researched report, filed
 * into the project. The server owns validation (cron / min-interval, prompt
 * length, name rules); this client only transports the documented shapes and
 * surfaces the BFF error envelope (`{ error, code }`).
 */

import type { TaskPage, TaskRunPage, TaskRunView, TaskView } from '@/lib/tasks/task-wire'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

/** A project's task, as the wire carries it. */
export type Job = TaskView

/** One run of a task, as the wire carries it. */
export type JobRun = TaskRunView

/** The page a project's task list is read in: every task the Tasks tab shows. */
export const TASK_LIST_PAGE = 200

/** Job create payload (`POST …/jobs`). */
export interface CreateJobInput {
  name: string
  prompt: string
  // No `output`. A standing task is always a research run that files a report;
  // the wire stopped carrying the choice with the wizard step that asked it.
  /** Omit (or null) for a job with no skill attached. */
  skillName?: string | null
  dataSources?: string[] | null
  enabled?: boolean
  scheduleCron?: string | null
  scheduleTimezone?: string
  /** ISO-8601 instant for a one-off task. Mutually exclusive with a cron. */
  dueAt?: string | null
}

/**
 * Partial update payload for `PATCH …/jobs/[jobId]`.
 *
 * `skillName: null` DETACHES the skill; omitting the field leaves the current
 * attachment alone.
 */
export type UpdateJobInput = Partial<CreateJobInput>

export interface ListJobRunsParams {
  limit?: number
}

export interface ListProjectRunsParams {
  limit: number
}

// ============================================================
// Errors
// ============================================================

/**
 * Carries the BFF error `code` (e.g. `UNPROCESSABLE`, `CONFLICT`) alongside
 * the HTTP status so callers can react structurally — e.g. render cron
 * validation feedback inline vs. show a generic failure alert.
 */
export class JobApiError extends ApiRequestError {
  readonly code: string | null
  /** The raw server error message (without the client-added context prefix). */
  readonly serverMessage: string | null

  constructor(message: string, status: number, code: string | null, serverMessage: string | null) {
    super(message, status)
    this.name = 'JobApiError'
    this.code = code
    this.serverMessage = serverMessage
  }
}

// ============================================================
// Helpers
// ============================================================

const jobsBase = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/tasks`

const runsBase = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/runs`

const parseErrorEnvelope = async (
  response: Response,
): Promise<{ message: string | null; code: string | null }> => {
  const text = await response.text().catch(() => '')
  if (!text) return { message: null, code: null }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown }
    const message = typeof parsed.error === 'string' ? parsed.error : null
    const code = typeof parsed.code === 'string' ? parsed.code : null
    return { message, code: code ?? null }
  } catch {
    return { message: text, code: null }
  }
}

const throwJobApiError = async (response: Response, context: string): Promise<never> => {
  const { message, code } = await parseErrorEnvelope(response)
  throw new JobApiError(
    `${context}: ${response.status}${message ? ` - ${message}` : ''}`,
    response.status,
    code,
    message,
  )
}

const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json' }

// ============================================================
// Project jobs API
// ============================================================

/**
 * A project's tasks, newest first: one page of {@link TASK_LIST_PAGE}, which
 * is more than a project's Tasks tab has ever held. A project past it shows the
 * newest page; the cursor is there for the day one needs the rest.
 */
export const listJobs = async (projectId: string): Promise<Job[]> => {
  const response = await fetch(`${jobsBase(projectId)}?limit=${TASK_LIST_PAGE}`, { headers: jsonHeaders })
  if (!response.ok) await throwJobApiError(response, 'Failed to list tasks')
  const data = (await response.json()) as Partial<TaskPage>
  return data.tasks ?? []
}

/** Fetch a single job with its saved skill snapshot, if it has one. */
export const getJob = async (projectId: string, jobId: string): Promise<Job> => {
  const response = await fetch(`${jobsBase(projectId)}/${encodeURIComponent(jobId)}`, {
    headers: jsonHeaders,
  })
  if (!response.ok) await throwJobApiError(response, 'Failed to load job')
  return (await response.json()) as Job
}

/**
 * Create a job. The server validates the prompt and the cron, and snapshots the
 * attached skill (when there is one) so a later edit to that skill cannot
 * change what this job sends.
 */
export const createJob = async (projectId: string, input: CreateJobInput): Promise<Job> => {
  const response = await fetch(jobsBase(projectId), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) await throwJobApiError(response, 'Failed to create task')
  const parsed = (await response.json()) as { task: Job }
  return parsed.task
}

/** Patch a job (re-resolves the snapshot and recomputes next_run_at). */
export const updateJob = async (
  projectId: string,
  jobId: string,
  input: UpdateJobInput,
): Promise<Job> => {
  const response = await fetch(`${jobsBase(projectId)}/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) await throwJobApiError(response, 'Failed to update job')
  return (await response.json()) as Job
}

/** Delete a task. Its runs stay, no longer linked to it. */
export const deleteJob = async (projectId: string, jobId: string): Promise<void> => {
  const response = await fetch(`${jobsBase(projectId)}/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: jsonHeaders,
  })
  // 204 or 200 both count as success.
  if (!response.ok) await throwJobApiError(response, 'Failed to delete job')
}

/**
 * Fire a task manually. Answers the run that was recorded: `queued` or
 * `running` when the backend took it, `skipped` (an org cap, a 429) or `error`
 * with the reason in `error` — neither of those is a thrown error. A disabled
 * task yields 409, surfaced as a thrown error.
 */
export const runJob = async (projectId: string, jobId: string): Promise<JobRun> => {
  const response = await fetch(`${jobsBase(projectId)}/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
    headers: jsonHeaders,
  })
  if (!response.ok) await throwJobApiError(response, 'Failed to run task')
  const parsed = (await response.json()) as { run: JobRun }
  return parsed.run
}

/** One task's runs, newest first: the first page of the project's run list, filtered to the task. */
export const listJobRuns = async (
  projectId: string,
  jobId: string,
  params: ListJobRunsParams = {},
): Promise<JobRun[]> => {
  const search = new URLSearchParams({ taskId: jobId })
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  const response = await fetch(`${runsBase(projectId)}?${search.toString()}`, { headers: jsonHeaders })
  if (!response.ok) await throwJobApiError(response, 'Failed to list task runs')
  const data = (await response.json()) as Partial<TaskRunPage>
  return data.runs ?? []
}

/**
 * A project's runs across every task, newest first: the first `limit` of the
 * project's run list, the feed the Tasks timeline groups.
 */
export const listProjectRuns = async (
  projectId: string,
  params: ListProjectRunsParams,
): Promise<JobRun[]> => {
  const response = await fetch(`${runsBase(projectId)}?limit=${params.limit}`)
  if (!response.ok) await throwJobApiError(response, 'Failed to list project runs')
  const data = (await response.json()) as Partial<TaskRunPage>
  return data.runs ?? []
}
