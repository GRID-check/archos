/**
 * Submit a reading to the research worker (ADR-0111): the intake's own agent,
 * acting as the person whose upload or click started it (ADR-0108).
 *
 * What the run is given is narrower than a scheduled run's, on purpose:
 *
 *  - the project's MAIN collection only. The profile is read by every member,
 *    so nothing from a restricted folder may feed it (design, „Decisions the
 *    review settled" 6). The envelope signs the same scope, so a tool that
 *    retrieves through it cannot widen it.
 *  - no project context, project memory or organization instructions. The
 *    agent asks the intake API what the project needs; a prompt view of the
 *    profile it is filling would only be read back as if it were a document.
 *  - no data sources beyond the project's documents, no memory reflection, no
 *    run row and no thread: the run writes values onto the profile, not a
 *    report anybody reads.
 *
 * The job id is minted here and claimed on the intake row BEFORE the
 * submission, so the run's first call finds itself the current reading.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { submitBackgroundRun } from '@/lib/jobs/background-run'
import type { JobPriority } from '@/lib/jobs/backend-client'
import { resolveRunContext, type RunContext } from '@/lib/jobs/run-context'

/** The research worker's agent for a reading (`backend/registry.py`). */
export const INTAKE_AGENT_TYPE = 'project_intake'

/** What started a reading: a finished upload is `bulk`, a person's click `interactive` (ADR-0079). */
export type IntakeTrigger = 'upload' | 'click'

export interface IntakeRunInput {
  organizationId: string
  projectId: string
  /** The requester: whose upload or click it was. */
  userId: string
  email: string | null
  /** The project's main collection (`projects.collection_name`). */
  collectionName: string
  /** The backend job id, already claimed on the intake row. */
  jobId: string
  scope: 'new' | 'all'
  trigger: IntakeTrigger
}

/** A job id the backend accepts as its idempotency id (`^[a-zA-Z0-9_-]+$`, ≤ 64). */
export function mintIntakeJobId(): string {
  return `intake-${randomUUID()}`
}

/** The occasion the agent's first message names. English: it is a prompt, not copy. */
export function intakeInstruction(scope: IntakeRunInput['scope'], trigger: IntakeTrigger): string {
  const what =
    scope === 'all'
      ? "Read every document of the project's main collection again."
      : "Read the documents of the project's main collection that have not been read yet."
  const why = trigger === 'upload' ? 'New documents were uploaded.' : 'A person asked for a reading.'
  return `${why} ${what}`
}

/** The run's context narrowed to what a reading may see (see the module doc). Pure. */
export function intakeRunContext(context: RunContext, collectionName: string): RunContext {
  return {
    ...context,
    collectionScope: [collectionName],
    projectContext: null,
    projectMemory: null,
    orgInstructions: null,
    memoryReflectionEnabled: false,
  }
}

const PRIORITY: Record<IntakeTrigger, JobPriority> = { upload: 'bulk', click: 'interactive' }

/** Submit the reading. Returns the backend's job id; throws what the submission throws. */
export async function submitIntakeRun(input: IntakeRunInput): Promise<string> {
  const subject = { organizationId: input.organizationId, projectId: input.projectId, userId: input.userId }
  const prompt = intakeInstruction(input.scope, input.trigger)
  const context = intakeRunContext(await resolveRunContext(subject, prompt), input.collectionName)
  const { jobId } = await submitBackgroundRun({
    subject,
    ownerEmail: input.email,
    prompt,
    skills: [],
    // The backend still wants an output kind; the agent type overrides the agent it picks.
    output: 'chat',
    agentType: INTAKE_AGENT_TYPE,
    jobId: input.jobId,
    conversationId: null,
    dataSources: null,
    priority: PRIORITY[input.trigger],
    context,
  })
  return jobId
}
