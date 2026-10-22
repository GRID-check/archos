/**
 * The wire of the tasks API (ADR-0131): what a task and a task run look like
 * to every client, and the queries their lists take.
 *
 * Two entities, one word each, as the glossary has them. A **task** is the
 * standing definition (a prompt, an optional schedule), served at
 * `/api/projects/[id]/tasks`. A **task run** is one attempt at it, served at
 * `/api/projects/[id]/runs`. The backend's async job id is how this tier talks
 * to the worker and never a field of either view; the one reader that needs it
 * (the browser's live stream) asks for it with `include=stream`.
 *
 * Pure: no database, no `server-only`, so the route, the catalog and the
 * browser read one shape (`lib/api/wire-modules.spec.ts`).
 */

import { z } from 'zod'
import { DOCUMENT_LIST_CURSOR_MAX_LENGTH } from '@/lib/documents/list-cursor'
import type { RunStatus } from '@/lib/runs/run-ledger-types'
import {
  TASK_RUN_STATUSES,
  type TaskKind,
  type TaskReview,
  type TaskRunStatus,
  type TaskRunTrigger,
} from './task-vocabulary'

/** Default page of a task or task-run list. */
export const TASK_PAGE_DEFAULT_LIMIT = 50
/** Largest page of a task or task-run list. */
export const TASK_PAGE_MAX_LIMIT = 200

const limitParam = z.coerce
  .number()
  .int()
  .min(1)
  .max(TASK_PAGE_MAX_LIMIT)
  .default(TASK_PAGE_DEFAULT_LIMIT)

const cursorParam = z.string().min(1).max(DOCUMENT_LIST_CURSOR_MAX_LENGTH).optional()

/** `GET /api/projects/[id]/tasks`. */
export const taskListQuerySchema = z.object({ limit: limitParam, cursor: cursorParam })
export type TaskListQuery = z.infer<typeof taskListQuerySchema>

/** A run's review state as a filter: `none` is a finished run nobody has judged yet. */
export const TASK_RUN_REVIEW_FILTERS = ['none', 'accepted', 'rejected'] as const
export type TaskRunReviewFilter = (typeof TASK_RUN_REVIEW_FILTERS)[number]

/** `GET /api/projects/[id]/runs`. */
export const taskRunListQuerySchema = z.object({
  limit: limitParam,
  cursor: cursorParam,
  taskId: z.string().uuid().optional(),
  status: z.enum(TASK_RUN_STATUSES).optional(),
  review: z.enum(TASK_RUN_REVIEW_FILTERS).optional(),
})
export type TaskRunListQuery = z.infer<typeof taskRunListQuerySchema>

/** `GET /api/projects/[id]/runs/[runId]`: `stream` adds the id the browser's live event stream is keyed by. */
export const runViewQuerySchema = z.object({
  include: z.enum(['stream']).optional().describe('Browser only.'),
})
export type RunViewQuery = z.infer<typeof runViewQuerySchema>

/** How much of a run's report `task-run-get` returns. A longer report is cut and says so. */
export const RUN_REPORT_MAX_CHARS = 20_000

/** A task: the standing definition. Dates are ISO strings. */
export interface TaskView {
  id: string
  projectId: string
  name: string
  /** The prompt each run is submitted with. */
  prompt: string
  /** The attached skill's name, or null. Its body is skill-get's. */
  skillName: string | null
  /**
   * What a run produces: `deep-research` files a report. Every task created
   * now is one; `chat` survives on definitions made before the wizard stopped
   * asking, which still run as a chat turn.
   */
  output: 'chat' | 'deep-research'
  dataSources: string[] | null
  enabled: boolean
  scheduleCron: string | null
  scheduleTimezone: string
  /** When a one-shot is due; null on a recurring or manual task. */
  dueAt: string | null
  nextRunAt: string | null
  lastRunAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

/** The three facts a run line needs from a ledger; nothing a block would. */
export interface TaskRunSummary {
  status: RunStatus
  rounds: number
  docs: number
}

/** A task run: one attempt. Every run list and `task-run-start` answer this. */
export interface TaskRunView {
  id: string
  /** The task it is a run of. Null only for a run whose task was never a definition. */
  taskId: string | null
  kind: TaskKind
  /** The task's name at the time, or the delegation's own title. */
  title: string
  /** What the requester asked for, in their words. Null for a scheduled run. */
  goal: string | null
  status: TaskRunStatus
  /** How a person judged the result. Null until somebody did. */
  review: TaskReview | null
  /** The reviewer's words on a rejection. */
  reviewReason: string | null
  /** The document the result was filed as, when it was. */
  filedDocumentId: string | null
  /** The conversation the run narrates itself in. */
  conversationId: string | null
  /** The run's own message in that conversation (ADR-0062), or null. */
  runMessageId: string | null
  /** How this run started: a timer, a "Run now", or an ask in chat. */
  trigger: TaskRunTrigger
  requesterUserId: string
  /** Their display name, or null when the directory cannot resolve the id. */
  requesterName: string | null
  createdAt: string
  finishedAt: string | null
  /** Why a run failed, was skipped or errored, in user-safe words. */
  error: string | null
  /** The compact run line off the run's ledger, when it has one. */
  runSummary?: TaskRunSummary | null
}

/** A page of tasks. */
export interface TaskPage {
  tasks: TaskView[]
  nextCursor: string | null
}

/** A page of task runs. */
export interface TaskRunPage {
  runs: TaskRunView[]
  nextCursor: string | null
}
