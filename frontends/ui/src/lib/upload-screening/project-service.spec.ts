/**
 * One project's sensitive-data list (migration 0157): who reads it, who may
 * change it, and that only what changes something is stored and audited.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/decide', () => ({ can: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('./project-repository', () => ({ saveProjectScreeningOverride: vi.fn() }))
vi.mock('./service', () => ({
  getUploadScreeningPolicy: vi.fn(),
  getProjectScreeningOverride: vi.fn(),
  hasSavedUploadScreeningPolicy: vi.fn(),
  forgetProjectScreeningOverride: vi.fn(),
}))

import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { can } from '@/lib/authz/decide'
import { requireProjectAccess } from '@/lib/authz/projects'
import { NotFoundError } from '@/lib/api/errors'
import { SUGGESTED_SCREENING_POLICY } from './policy'
import { saveProjectScreeningOverride } from './project-repository'
import { getProjectUploadScreening, saveProjectUploadScreening } from './project-service'
import {
  forgetProjectScreeningOverride,
  getProjectScreeningOverride,
  getUploadScreeningPolicy,
  hasSavedUploadScreeningPolicy,
} from './service'

const session = { organizationId: 'org-1', userId: 'user-1', email: 'a@b.at' } as AuthorizedSession
const request = new Request('http://localhost/api/projects/p-1/upload-screening', { method: 'PUT' })

function given(options: { manage?: boolean; closed?: boolean; stored?: { addedNameTerms: string[]; removedNameTerms: string[] } | null }) {
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'editor', closed: options.closed ?? false, readsBecauseClosed: false } as never)
  vi.mocked(can).mockResolvedValue(options.manage ?? false)
  vi.mocked(getUploadScreeningPolicy).mockResolvedValue(SUGGESTED_SCREENING_POLICY)
  vi.mocked(getProjectScreeningOverride).mockResolvedValue(options.stored ?? null)
  vi.mocked(hasSavedUploadScreeningPolicy).mockResolvedValue(false)
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('getProjectUploadScreening', () => {
  it('answers any member who may read the project with the policy in force and what the project changes', async () => {
    given({ stored: { addedNameTerms: ['Wettbewerb'], removedNameTerms: ['Vertrag', 'Unbekannt'] } })
    const view = await getProjectUploadScreening(session, 'p-1')
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'p-1', 'project:view')
    expect(view.override).toEqual({ addedNameTerms: ['Wettbewerb'], removedNameTerms: ['Vertrag'] })
    expect(view.policy.nameTerms).toContain('Wettbewerb')
    expect(view.policy.nameTerms).not.toContain('Vertrag')
    expect(view.office).toBe(SUGGESTED_SCREENING_POLICY)
    expect(view).toMatchObject({ officeSuggested: true, canManage: false })
  })

  it('says a project manager may change it, but not on a closed project', async () => {
    given({ manage: true })
    expect((await getProjectUploadScreening(session, 'p-1')).canManage).toBe(true)
    given({ manage: true, closed: true })
    expect((await getProjectUploadScreening(session, 'p-1')).canManage).toBe(false)
  })

  it('passes on the 404 of a project the reader may not see', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    await expect(getProjectUploadScreening(session, 'p-1')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('saveProjectUploadScreening', () => {
  it('needs project:manage and stores nothing without it', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    await expect(
      saveProjectUploadScreening(session, 'p-1', { addedNameTerms: ['X1'], removedNameTerms: [] }, request)
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'p-1', 'project:manage')
    expect(saveProjectScreeningOverride).not.toHaveBeenCalled()
  })

  it('stores what changes something, forgets the cached copy and audits counts, never terms', async () => {
    given({ manage: true })
    await saveProjectUploadScreening(
      session,
      'p-1',
      { addedNameTerms: ['Wettbewerb', 'Rechnung'], removedNameTerms: ['Vertrag', 'Unbekannt'] },
      request
    )
    expect(saveProjectScreeningOverride).toHaveBeenCalledWith(
      'org-1',
      'p-1',
      { addedNameTerms: ['Wettbewerb'], removedNameTerms: ['Vertrag'] },
      'user-1'
    )
    expect(forgetProjectScreeningOverride).toHaveBeenCalledWith('org-1', 'p-1')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.upload_screening.updated',
        targetType: 'project',
        targetId: 'p-1',
        metadata: { addedNameTerms: 1, removedNameTerms: 1 },
      })
    )
    expect(JSON.stringify(vi.mocked(recordAuditEvent).mock.calls)).not.toContain('Wettbewerb')
  })

  it("fails rather than measuring the change against Piloti's suggestion when the office list cannot be read", async () => {
    given({ manage: true })
    vi.mocked(getUploadScreeningPolicy).mockRejectedValue(new Error('db down'))
    await expect(
      saveProjectUploadScreening(session, 'p-1', { addedNameTerms: ['X1'], removedNameTerms: [] }, request)
    ).rejects.toThrow('db down')
    expect(saveProjectScreeningOverride).not.toHaveBeenCalled()
  })
})
