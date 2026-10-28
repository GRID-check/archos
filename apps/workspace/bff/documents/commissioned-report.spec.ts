/**
 * @vitest-environment node
 *
 * A reader's GET of a finished run's report is where the BFF observes the run's
 * completion (`app/api/jobs/async/[...path]/route.ts`), and this is what it
 * does with the body: decide whether a promise to file was made, keep it by
 * queueing the filing, or say it was broken.
 *
 * Mocked at `./research-report`, whose probe, refusal and queue have their own
 * spec (`research-report-queue.spec.ts`); what is asserted here is the
 * decision around them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./research-report', () => ({
  findFiledResearchReport: vi.fn(),
  findReportFilingRefusal: vi.fn(),
  queueResearchReportFiling: vi.fn(),
}))
vi.mock('@/lib/projects/repository', () => ({ findProjectIdByCollectionName: vi.fn() }))

import type { AuthorizedSession } from '@/lib/auth/types'
import { findProjectIdByCollectionName } from '@/lib/projects/repository'
import { fileCommissionedReport } from './commissioned-report'
import { findFiledResearchReport, findReportFilingRefusal, queueResearchReportFiling } from './research-report'

const READER = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'user@app.example',
  name: 'Test User',
  accessToken: 'token-abc',
  organizationMembershipId: 'membership-1',
  role: 'member',
  permissions: ['project:documents:write'],
  featureFlags: ['deep-research'],
} as AuthorizedSession

// `project_collection` is on every real report body: the backend records the
// commissioning project on `job_access` at submit time and returns it here.
// It — not the request's project — is what decides where the report is filed.
const REPORT_BODY = {
  job_id: 'job-1',
  has_report: true,
  report: '# Bericht\n\nText.',
  project_collection: 'proj_abc',
}

const file = (body: unknown, session: AuthorizedSession | null = READER) =>
  fileCommissionedReport({ runId: 'job-1', session, body })

const queuedPayload = () => vi.mocked(queueResearchReportFiling).mock.calls[0][0].payload

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findProjectIdByCollectionName).mockResolvedValue('proj-1')
  vi.mocked(findFiledResearchReport).mockResolvedValue(null)
  vi.mocked(findReportFilingRefusal).mockResolvedValue(null)
  vi.mocked(queueResearchReportFiling).mockResolvedValue({ jobId: 'bff-job-1' })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('fileCommissionedReport', () => {
  it('queues the filing of the finished report, as the reader, and says it is on its way', async () => {
    await expect(file(REPORT_BODY)).resolves.toEqual({ outcome: 'queued' })

    // The PDF is rendered by a `bff-jobs` pod (ADR-0079), as the reader.
    expect(queueResearchReportFiling).toHaveBeenCalledWith({
      organizationId: 'org-1',
      payload: expect.objectContaining({
        projectId: 'proj-1',
        runId: 'job-1',
        report: REPORT_BODY.report,
        taskRunId: null,
        requester: expect.objectContaining({ userId: 'user-1', organizationMembershipId: 'membership-1' }),
      }),
    })
  })

  it('answers a reader who may not file with a refusal, and queues nothing', async () => {
    vi.mocked(findReportFilingRefusal).mockResolvedValue('ForbiddenError: Agent-authored documents are disabled')

    await expect(file(REPORT_BODY)).resolves.toEqual({ outcome: 'refused' })

    expect(findReportFilingRefusal).toHaveBeenCalledWith(READER, 'proj-1')
    expect(queueResearchReportFiling).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled() // a refusal is an answer, not a fault
  })

  it('says where a report that is already filed landed, without a job', async () => {
    vi.mocked(findFiledResearchReport).mockResolvedValue({
      documentId: 'doc-1',
      filename: 'bericht-2026-08-20.pdf',
      folderId: 'folder-1',
      alreadyFiled: true,
    })

    await expect(file(REPORT_BODY)).resolves.toEqual({
      outcome: 'filed',
      filed: { documentId: 'doc-1', filename: 'bericht-2026-08-20.pdf', alreadyFiled: true },
    })
    expect(findFiledResearchReport).toHaveBeenCalledWith({ organizationId: 'org-1', projectId: 'proj-1', runId: 'job-1' })
    expect(queueResearchReportFiling).not.toHaveBeenCalled()
  })

  it('files into the project the RUN names, looked up in the reader’s organization', async () => {
    // The reader may have a different project open, or reopen an old run from
    // history. The cover sheet names the Bundesland, which says which Bauordnung
    // the report was checked against, so the run's project is the only answer.
    vi.mocked(findProjectIdByCollectionName).mockResolvedValue('proj-the-run-belongs-to')

    await file(REPORT_BODY)

    expect(findProjectIdByCollectionName).toHaveBeenCalledWith('proj_abc', 'org-1')
    expect(queuedPayload()).toMatchObject({ projectId: 'proj-the-run-belongs-to' })
  })

  it('files nothing, and claims no failure, for a run never commissioned in a project', async () => {
    // Its banner promised no filing; none was made, so none was broken.
    await expect(file({ job_id: 'job-1', has_report: true, report: '# Bericht' })).resolves.toBeNull()
    expect(queueResearchReportFiling).not.toHaveBeenCalled()
  })

  it('files nothing when the run’s collection belongs to no project in this organization', async () => {
    // The cross-tenant version of the same bug: a real collection name that
    // this organization does not own must not fall back to anywhere.
    vi.mocked(findProjectIdByCollectionName).mockResolvedValue(null)

    await expect(file(REPORT_BODY)).resolves.toBeNull()
    expect(queueResearchReportFiling).not.toHaveBeenCalled()
  })

  it('passes the run’s cards through, so the filed PDF can render Rechtsgrundlagen', async () => {
    const cards = [{ type: 'legal_basis', title: 'OIB-Richtlinie 2', lane: 'oib' }]

    await file({ ...REPORT_BODY, cards })

    expect(queuedPayload()).toMatchObject({ cards })
  })

  it('passes no cards rather than an empty list when the run produced none', async () => {
    // `legalBasisSection` prints no heading for an absent value; an empty array
    // would be a promise of a section that then has nothing under it.
    await file({ ...REPORT_BODY, cards: [] })

    expect(queuedPayload().cards).toBeUndefined()
  })

  it('files the report anyway when `cards` is malformed', async () => {
    await expect(file({ ...REPORT_BODY, cards: 'nonsense' })).resolves.toEqual({ outcome: 'queued' })
    expect(queuedPayload().cards).toBeUndefined()
  })

  it('reports a broken promise without its reason when the filing cannot be queued', async () => {
    // The reason stays in the log: a bucket, a permission or a limit is
    // actionable by an operator, not by the architect reading the report.
    vi.mocked(queueResearchReportFiling).mockRejectedValue(new Error('quota exceeded'))

    const outcome = await file(REPORT_BODY)

    expect(outcome).toEqual({ outcome: 'failed' })
    expect(JSON.stringify(outcome)).not.toContain('quota exceeded')
    expect(console.error).toHaveBeenCalled()
  })

  it('files nothing for a run that has no report yet', async () => {
    await expect(file({ job_id: 'job-1', has_report: false, report: null })).resolves.toBeNull()
    expect(queueResearchReportFiling).not.toHaveBeenCalled()
  })

  /**
   * Interactive runs only (design decision 10). A scheduled run is filed by the
   * worker's outcome callback; anonymous mode reaches the proxy with no session,
   * and the answer is the same one: file nothing.
   */
  it('files nothing when there is no session to authorize the write', async () => {
    await expect(file(REPORT_BODY, null)).resolves.toBeNull()
    expect(findProjectIdByCollectionName).not.toHaveBeenCalled()
    expect(queueResearchReportFiling).not.toHaveBeenCalled()
  })
})
