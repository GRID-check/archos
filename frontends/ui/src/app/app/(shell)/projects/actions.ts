'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { BadRequestError } from '@/lib/api/errors'
import { createProjectSchema } from '@/lib/projects/create-project-schema'
import { isMonth } from '@/lib/projects/month'
import { PROJECT_OUTCOMES, type ProjectOutcome } from '@/lib/projects/project-status'
import {
  createProject as createProjectInOrg,
  type CreateProjectInput,
  type ProjectClosing,
} from '@/lib/projects/service'

export interface CreateProjectState {
  error?: string
  /**
   * Which field the error is about, for the form: the service's 400 reason
   * (`abschluss-in-future`, `abschluss-before-beginn`, `invalid-month`), or
   * `invalid-outcome` when a closed project names no outcome.
   */
  reason?: string
}

/**
 * Create a project from the projects-page form.
 *
 * Server actions are transport, exactly like route handlers: open a scope,
 * resolve the session, validate the input shape, call the service, redirect.
 * This one used to re-implement the whole of `projects/service.ts#createProject`
 * — the same insert, the same WorkOS resource, the same role assignment, the
 * same audit event — which meant the two copies could (and did) drift.
 *
 * A server action gets no route factory, so like a page it opens its own tenant
 * slot; without one every query underneath runs with no context and fails
 * closed under row-level security.
 */
export async function createProject(
  _prevState: CreateProjectState,
  formData: FormData
): Promise<CreateProjectState> {
  const projectId = await withPageSession(async (session) => {
    const name = formData.get('name')
    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 255) {
      return { error: 'Project name is required and must be 1-255 characters.' } as const
    }

    const closing = closingFromForm(formData)
    if (closing && 'error' in closing) return closing

    const setup = setupFromForm(formData)
    if ('error' in setup) return setup

    try {
      const project = await createProjectInOrg(session, {
        name: name.trim(),
        ...(closing ? { closing } : {}),
        ...setup,
      })
      return { id: project.id, closed: closing !== undefined, setup: setup.setup } as const
    } catch (error) {
      console.error('[createProject] Failed to create project:', error)
      const reason = reasonOf(error)
      return {
        error: error instanceof Error ? error.message : 'Unknown error',
        ...(reason ? { reason } : {}),
      } as const
    }
  })

  if ('error' in projectId) {
    return { error: projectId.error, ...(projectId.reason ? { reason: projectId.reason } : {}) }
  }

  // `'/app', 'layout'` rather than `'/app/projects', 'page'`.
  //
  // The rail's project list is now resolved in the `(shell)` LAYOUT, not in the
  // page — that is what makes it persist across navigation. The flip side is
  // that a page-scoped revalidation no longer reaches it: the redirect below
  // walks to a route whose shell segment is already in the client router cache,
  // so Next would reuse the cached layout payload and the switcher would open
  // without the project that was just created. Revalidating the layout marks
  // that segment stale too, so the first navigation after a create refetches
  // the rail. (Renames go the other way — `project-rename-button.tsx` calls
  // `router.refresh()`, which refetches the current route INCLUDING its
  // layouts, so the new name reaches the switcher without a server action.)
  revalidatePath('/app', 'layout')
  // Land new projects directly in their setup: the brief is what makes Piloti's
  // answers (and the applicable-standards panel) useful, so creating flows
  // straight into it. „Piloti richtet ein" lands on the setup page, where the
  // documents are dropped and read (ADR-0111); „Selbst ausfüllen" on the wizard.
  // A project created closed the old way lands on its overview instead: intake
  // is read-only once closed (ADR-0098). A closed project Piloti sets up is still
  // active until the review is finished, so it lands on the setup page too.
  // Outside the scope on purpose: `redirect()` reports itself by throwing, and a
  // throw is not something the tenant slot should be unwinding through.
  redirect(createdProjectPath(projectId))
}

/** Where a project just created lands. */
function createdProjectPath(created: { id: string; closed: boolean; setup: 'piloti' | 'self' }): string {
  if (created.setup === 'piloti') return `/app/projects/${created.id}/setup`
  return created.closed ? `/app/projects/${created.id}/settings` : `/app/projects/${created.id}/intake`
}

type FormRefusal = { error: string; reason: string }

/**
 * The closing a form asks for (ADR-0098): none unless `state` is `closed`.
 * Shape only; whether the Abschluss fits the Beginn and this month is the
 * service's 400, so the bounds live in one place.
 */
function closingFromForm(formData: FormData): ProjectClosing | FormRefusal | undefined {
  if (formData.get('state') !== 'closed') return undefined
  const outcome = formData.get('outcome')
  if (!isOutcome(outcome)) {
    return { error: 'Choose how the project ended.', reason: 'invalid-outcome' }
  }
  const endedOn = formData.get('endedOn')
  const startedOn = formData.get('startedOn') ?? ''
  if (typeof endedOn !== 'string' || !isMonth(endedOn)) {
    return { error: 'The Abschluss must be a month, YYYY-MM.', reason: 'invalid-month' }
  }
  if (typeof startedOn !== 'string' || (startedOn !== '' && !isMonth(startedOn))) {
    return { error: 'The Beginn must be a month, YYYY-MM.', reason: 'invalid-month' }
  }
  return { outcome, endedOn, startedOn: startedOn === '' ? null : startedOn }
}

/** The form's Einrichtung, „Worum geht es?", address and Bundesland, checked as the route checks its body. */
function setupFromForm(
  formData: FormData
): (Required<Pick<CreateProjectInput, 'setup'>> & Pick<CreateProjectInput, 'description' | 'location' | 'federalState'>) | FormRefusal {
  const location = formData.get('location')
  const parsed = createProjectSchema.pick({ setup: true, description: true, location: true, bundesland: true }).safeParse({
    setup: formData.get('setup') ?? 'self',
    description: formData.get('description') ?? undefined,
    location: typeof location === 'string' && location !== '' ? safeJson(location) : undefined,
    bundesland: formData.get('bundesland') || undefined,
  })
  if (!parsed.success) return { error: 'The setup details are not valid.', reason: 'invalid-setup' }
  const { setup, description, location: place, bundesland: federalState } = parsed.data
  return {
    setup,
    ...(description ? { description } : {}),
    ...(place ? { location: place } : {}),
    ...(federalState ? { federalState } : {}),
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isOutcome(value: unknown): value is ProjectOutcome {
  return typeof value === 'string' && (PROJECT_OUTCOMES as readonly string[]).includes(value)
}

/** The machine-readable reason of a service 400, for the form's field error. */
function reasonOf(error: unknown): string | undefined {
  if (!(error instanceof BadRequestError)) return undefined
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  return typeof reason === 'string' ? reason : undefined
}
