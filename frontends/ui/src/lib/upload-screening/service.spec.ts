/**
 * @vitest-environment node
 */
/**
 * The server's repeat of the name gate (ADR-0086), when the office's policy
 * cannot be read.
 *
 * It is the authority for a client that skipped the browser's check, so it
 * must not decide with Piloti's suggested list: a file that matches only a
 * term the office added would pass that list and be stored. It refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/organizations/service', () => ({
  getOrgSettings: vi.fn(),
  writeDedicatedOrgSetting: vi.fn(),
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('./project-repository', () => ({ findProjectScreeningOverride: vi.fn().mockResolvedValue(null) }))

import { invalidateCached } from '@/lib/cache'
import { getOrgSettings } from '@/lib/organizations/service'
import { SUGGESTED_SCREENING_POLICY } from './policy'
import { findProjectScreeningOverride } from './project-repository'
import { ScreenedUploadError, ScreeningPolicyUnavailableError, assertUploadNameAllowed } from './service'

const officePolicy = { ...SUGGESTED_SCREENING_POLICY, nameTerms: [...SUGGESTED_SCREENING_POLICY.nameTerms, 'Huber'] }

beforeEach(async () => {
  await invalidateCached('upload-screening:org-1')
  await invalidateCached('upload-screening:org-1:project:p-1')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('assertUploadNameAllowed', () => {
  it("refuses a name that matches only the office's own term", async () => {
    vi.mocked(getOrgSettings).mockResolvedValue({
      displayName: null,
      defaultLocale: 'de',
      settings: { uploadScreening: officePolicy },
    })
    await expect(assertUploadNameAllowed('org-1', { filename: 'Notizen Huber.pdf' }, false)).rejects.toBeInstanceOf(
      ScreenedUploadError
    )
  })

  it('refuses every upload with a 503 while the policy cannot be read, rather than screening with the suggestion', async () => {
    vi.mocked(getOrgSettings).mockRejectedValue(new Error('db down'))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const refusal = await assertUploadNameAllowed('org-1', { filename: 'Notizen Huber.pdf' }, false).catch(
      (error: unknown) => error
    )

    expect(refusal).toBeInstanceOf(ScreeningPolicyUnavailableError)
    expect(refusal).toMatchObject({ status: 503, code: 'UPLOAD_SCREENING_UNAVAILABLE' })
    errorLog.mockRestore()
  })
})

describe('assertUploadNameAllowed into a project (migration 0158)', () => {
  beforeEach(() => {
    vi.mocked(getOrgSettings).mockResolvedValue({
      displayName: null,
      defaultLocale: 'de',
      settings: { uploadScreening: officePolicy },
    })
  })

  it("lets through what the project set aside, and holds back the project's own term", async () => {
    vi.mocked(findProjectScreeningOverride).mockResolvedValue({
      addedNameTerms: ['Wettbewerb intern'],
      removedNameTerms: ['Vertrag'],
    })
    await expect(assertUploadNameAllowed('org-1', { filename: 'Werkvertrag.pdf' }, false, 'p-1')).resolves.toEqual({
      overridden: [],
    })
    await expect(
      assertUploadNameAllowed('org-1', { filename: 'a.pdf', originPath: 'Wettbewerb intern/a.pdf' }, false, 'p-1')
    ).rejects.toBeInstanceOf(ScreenedUploadError)
    expect(findProjectScreeningOverride).toHaveBeenCalledWith('org-1', 'p-1')
  })

  it("screens an upload outside a project with the office's list alone", async () => {
    await expect(assertUploadNameAllowed('org-1', { filename: 'Werkvertrag.pdf' }, false)).rejects.toBeInstanceOf(
      ScreenedUploadError
    )
    expect(findProjectScreeningOverride).not.toHaveBeenCalled()
  })

  it("refuses with a 503 while the project's changes cannot be read", async () => {
    vi.mocked(findProjectScreeningOverride).mockRejectedValue(new Error('db down'))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(assertUploadNameAllowed('org-1', { filename: 'Notiz.pdf' }, false, 'p-1')).rejects.toBeInstanceOf(
      ScreeningPolicyUnavailableError
    )
    errorLog.mockRestore()
  })
})
