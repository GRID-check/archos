/**
 * @vitest-environment node
 *
 * The projects-page create action reads the form (ADR-0098): an active
 * project as before, or a past one created closed with its outcome, Beginn
 * and Abschluss. A refusal names the field it is about, and a closed project
 * lands on its overview, since its intake is read-only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }))

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`)
})
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }))

const session = { userId: 'user_pl', organizationId: 'org_1' }
vi.mock('@/lib/auth/require-auth', () => ({
  withPageSession: (fn: (s: typeof session) => unknown) => fn(session),
}))

const createProjectInOrg = vi.fn()
vi.mock('@/lib/projects/service', () => ({
  createProject: (...args: unknown[]) => createProjectInOrg(...args),
}))

import { BadRequestError } from '@/lib/api/errors'
import { createProject } from './actions'

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.set(key, value)
  return data
}

describe('createProject (server action)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    createProjectInOrg.mockResolvedValue({ id: 'p1' })
  })

  it('creates an active project and lands in intake, as before', async () => {
    await expect(createProject({}, form({ name: ' Seestadt ' }))).rejects.toThrow('NEXT_REDIRECT /app/projects/p1/intake')
    expect(createProjectInOrg).toHaveBeenCalledWith(session, { name: 'Seestadt' })
    expect(revalidatePath).toHaveBeenCalledWith('/app', 'layout')
  })

  it('treats an unknown state as active and ignores closing fields then', async () => {
    await expect(
      createProject({}, form({ name: 'Seestadt', state: 'archived', outcome: 'completed', endedOn: '2022-08' }))
    ).rejects.toThrow('/intake')
    expect(createProjectInOrg).toHaveBeenCalledWith(session, { name: 'Seestadt' })
  })

  it('creates a closed project with its outcome, Beginn and Abschluss, and lands on the overview', async () => {
    await expect(
      createProject({}, form({ name: 'Volksschule', state: 'closed', outcome: 'completed', startedOn: '2019-03', endedOn: '2022-08' }))
    ).rejects.toThrow('NEXT_REDIRECT /app/projects/p1/settings')
    expect(createProjectInOrg).toHaveBeenCalledWith(session, {
      name: 'Volksschule',
      closing: { outcome: 'completed', startedOn: '2019-03', endedOn: '2022-08' },
    })
    expect(revalidatePath).toHaveBeenCalledWith('/app', 'layout')
  })

  it('reads an empty Beginn as none', async () => {
    await expect(
      createProject({}, form({ name: 'Wettbewerb', state: 'closed', outcome: 'cancelled', startedOn: '', endedOn: '2026-09' }))
    ).rejects.toThrow('/settings')
    expect(createProjectInOrg).toHaveBeenCalledWith(session, {
      name: 'Wettbewerb',
      closing: { outcome: 'cancelled', startedOn: null, endedOn: '2026-09' },
    })
  })

  it.each([
    ['no outcome', { endedOn: '2022-08' }, 'invalid-outcome'],
    ['an unknown outcome', { outcome: 'won', endedOn: '2022-08' }, 'invalid-outcome'],
    ['no Abschluss', { outcome: 'completed' }, 'invalid-month'],
    ['a malformed Beginn', { outcome: 'completed', endedOn: '2022-08', startedOn: '2019' }, 'invalid-month'],
  ])('refuses a closed project with %s before calling the service', async (_, fields, reason) => {
    const state = await createProject({}, form({ name: 'X', state: 'closed', ...fields }))
    expect(state).toMatchObject({ reason, error: expect.any(String) })
    expect(createProjectInOrg).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
  })

  it("passes the service's 400 reason through, so the form marks the right field", async () => {
    createProjectInOrg.mockRejectedValue(
      new BadRequestError('The Abschluss cannot lie in the future.', { reason: 'abschluss-in-future' })
    )
    const state = await createProject({}, form({ name: 'X', state: 'closed', outcome: 'completed', endedOn: '2030-01' }))
    expect(state).toEqual({ error: 'The Abschluss cannot lie in the future.', reason: 'abschluss-in-future' })
  })

  it('returns no reason for a failure that is not a 400', async () => {
    createProjectInOrg.mockRejectedValue(new Error('workos down'))
    const state = await createProject({}, form({ name: 'X' }))
    expect(state).toEqual({ error: 'workos down' })
  })

  it('still refuses a missing name', async () => {
    const state = await createProject({}, form({ name: '  ' }))
    expect(state.error).toMatch(/name/)
    expect(createProjectInOrg).not.toHaveBeenCalled()
  })
})
