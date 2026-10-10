/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document, DocumentVersion } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/assignments/repository', () => ({ listAssignmentsForResources: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ filterUsersWhoMayReadFolder: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({
  resolveSubjectMembership: vi.fn(),
  userHoldsProjectPermission: vi.fn(),
}))
vi.mock('@/lib/inbox/repository', () => ({ recipientsHoldingGroup: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn().mockResolvedValue(0) }))
vi.mock('./repository', () => ({ findDocumentInOrg: vi.fn(), findFassungCounterparts: vi.fn() }))
vi.mock('./reconcile-status', () => ({ readFassungNames: vi.fn(), refreshCollectionFiles: vi.fn() }))
vi.mock('./version-repository', () => ({ findPublishedVersion: vi.fn(), findPreviousVersion: vi.fn() }))

import { listAssignmentsForResources } from '@/lib/assignments/repository'
import { filterUsersWhoMayReadFolder } from '@/lib/authz/folder-access'
import { resolveSubjectMembership, userHoldsProjectPermission } from '@/lib/authz/project-membership'
import { recipientsHoldingGroup } from '@/lib/inbox/repository'
import { emitInboxItems } from '@/lib/inbox/service'
import { SCREENED_ONLY } from './document-reader'
import {
  announceNewFassung,
  announceSettledVersions,
  fassungRecipients,
  fassungRowNames,
  firstSummaryLine,
  notifyNewFassung,
} from './fassung-notify'
import { readFassungNames, refreshCollectionFiles } from './reconcile-status'
import { findDocumentInOrg, findFassungCounterparts } from './repository'
import { findPreviousVersion, findPublishedVersion } from './version-repository'

const doc = (overrides: Partial<Document>): Document =>
  ({
    id: 'doc-a',
    filename: 'Grundriss_A.pdf',
    displayName: null,
    scope: 'project',
    projectId: 'p1',
    folderId: null,
    lifecycle: 'active',
    authoredBy: 'user',
    collectionName: 'proj_abc',
    publishedVersionId: null,
    status: 'completed',
    screeningOutcome: 'clean',
    contentHash: 'h',
    screenedHash: 'h',
    createdBy: 'uploader',
    ...overrides,
  }) as Document

const OLDER = doc({ id: 'doc-a', filename: 'Grundriss_A.pdf', createdBy: 'uploader' })
const NEWER = doc({ id: 'doc-b', filename: 'Grundriss_B.pdf', createdBy: 'editor' })

function assignedTo(...userIds: string[]) {
  vi.mocked(listAssignmentsForResources).mockResolvedValue(
    userIds.map((subjectUserId) => ({
      resourceType: 'document',
      resourceId: 'doc-a',
      subjectUserId,
      assignedBy: 'someone',
      createdAt: new Date(),
    })),
  )
}

function emitted() {
  return vi.mocked(emitInboxItems).mock.calls.flatMap(([items]) => items)
}

const link = {
  organizationId: 'org-1',
  actorUserId: 'editor',
  newerId: 'doc-b',
  olderId: 'doc-a',
} as const

beforeEach(() => {
  vi.mocked(emitInboxItems).mockReset()
  vi.mocked(emitInboxItems).mockResolvedValue(0)
  vi.mocked(findDocumentInOrg).mockReset()
  vi.mocked(findDocumentInOrg).mockImplementation(async (id) => [OLDER, NEWER].find((d) => d.id === id) ?? null)
  vi.mocked(listAssignmentsForResources).mockReset()
  assignedTo()
  vi.mocked(userHoldsProjectPermission).mockReset()
  vi.mocked(userHoldsProjectPermission).mockResolvedValue(true)
  vi.mocked(filterUsersWhoMayReadFolder).mockReset()
  vi.mocked(filterUsersWhoMayReadFolder).mockImplementation(async (_org, _project, _folder, ids) => new Set(ids))
  vi.mocked(resolveSubjectMembership).mockReset()
  vi.mocked(recipientsHoldingGroup).mockReset()
  vi.mocked(recipientsHoldingGroup).mockResolvedValue(new Set())
  vi.mocked(findPublishedVersion).mockReset()
  vi.mocked(findPreviousVersion).mockReset()
  vi.mocked(readFassungNames).mockReset()
  vi.mocked(readFassungNames).mockResolvedValue(null)
  vi.mocked(refreshCollectionFiles).mockReset()
  vi.mocked(refreshCollectionFiles).mockResolvedValue(undefined)
  vi.mocked(findFassungCounterparts).mockReset()
  vi.mocked(findFassungCounterparts).mockResolvedValue([])
})

describe('fassungRecipients', () => {
  it('is the assignees and the uploaders, once each, without the person who made the change', () => {
    expect(
      fassungRecipients({
        assigneeIds: ['anna', 'bernd', 'editor'],
        uploaderIds: ['anna', 'carla', null, undefined],
        actorUserId: 'editor',
      }),
    ).toEqual(['anna', 'bernd', 'carla'])
  })

  it('tells everyone when no person made the change', () => {
    expect(fassungRecipients({ assigneeIds: ['anna'], uploaderIds: ['editor'], actorUserId: null })).toEqual([
      'anna',
      'editor',
    ])
  })
})

describe('fassungRowNames', () => {
  it('names a document as people see it, without the file extension', () => {
    expect(fassungRowNames({ filename: 'Grundriss EG Index B.pdf' }, { filename: 'Grundriss EG Index C.pdf' })).toEqual({
      subject: 'Grundriss EG Index B',
      related: 'Grundriss EG Index C',
    })
  })

  it('keeps a label that carries no extension whole, digits and dots included', () => {
    expect(fassungRowNames({ filename: 'x.pdf', displayName: 'Stand 14.08.2026' }, null)).toEqual({
      subject: 'Stand 14.08.2026',
    })
  })

  it('takes the extension off a renamed label that still ends in it', () => {
    expect(fassungRowNames({ filename: 'scan.PDF', displayName: 'Bescheid Bauamt.pdf' }, null)).toEqual({
      subject: 'Bescheid Bauamt',
    })
  })

  it('keeps the extensions when they are all that tells the two apart', () => {
    expect(fassungRowNames({ filename: 'Grundriss.pdf' }, { filename: 'Grundriss.dwg' })).toEqual({
      subject: 'Grundriss.pdf',
      related: 'Grundriss.dwg',
    })
  })

  it('keeps a name that is nothing but its extension', () => {
    expect(fassungRowNames({ filename: '.pdf' }, null)).toEqual({ subject: '.pdf' })
  })
})

describe('firstSummaryLine', () => {
  it('is the first line that says something, without list or heading markers', () => {
    expect(firstSummaryLine('\n  \n- Wand im EG verschoben\n- Tür neu')).toBe('Wand im EG verschoben')
    expect(firstSummaryLine('## Änderungen\nTür neu')).toBe('Änderungen')
  })

  it('is null for nothing to say', () => {
    expect(firstSummaryLine(null)).toBeNull()
    expect(firstSummaryLine(' \n ')).toBeNull()
  })

  it('cuts a very long line', () => {
    const line = firstSummaryLine('x'.repeat(500))
    expect(line?.length).toBe(200)
    expect(line?.endsWith('…')).toBe(true)
  })
})

describe('notifyNewFassung — a confirmed link', () => {
  it('tells the older document\'s assignees and uploader, not the person who linked, pointing at the newer document', async () => {
    assignedTo('anna', 'editor')

    const told = await notifyNewFassung({ ...link, changeSummary: 'Wand verschoben.\nTür neu.' })

    expect(told).toBe(2)
    const items = emitted()
    expect(items.map((item) => item.recipientUserId).sort()).toEqual(['anna', 'uploader'])
    for (const item of items) {
      expect(item).toMatchObject({
        organizationId: 'org-1',
        type: 'document.new_fassung',
        resourceType: 'document',
        resourceId: 'doc-b',
        anchorId: 'doc-a',
        actorUserId: 'editor',
        payload: { subject: 'Grundriss_A', related: 'Grundriss_B', excerpt: 'Wand verschoben.' },
      })
      expect(item.groupKey).toContain('doc-b')
    }
  })

  it('leaves the excerpt out when there is no change summary', async () => {
    await notifyNewFassung(link)

    expect(emitted()[0].payload).toEqual({ subject: 'Grundriss_A', related: 'Grundriss_B' })
  })

  it('names the documents as people see them: a renamed one by its label', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-b' ? doc({ ...NEWER, displayName: 'EG Index C' }) : OLDER,
    )

    await notifyNewFassung(link)

    expect(emitted()[0].payload).toMatchObject({ related: 'EG Index C' })
  })

  it('asks both documents through the screened-only reader, so a held one is never read', async () => {
    await notifyNewFassung(link)

    expect(findDocumentInOrg).toHaveBeenCalledWith('doc-b', 'org-1', SCREENED_ONLY)
    expect(findDocumentInOrg).toHaveBeenCalledWith('doc-a', 'org-1', SCREENED_ONLY)
  })

  it('says nothing about a held newer document', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) => (id === 'doc-a' ? OLDER : null))
    assignedTo('anna')

    expect(await notifyNewFassung(link)).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('says nothing when the older document is held either', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) => (id === 'doc-b' ? NEWER : null))

    expect(await notifyNewFassung(link)).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('says nothing about an archived newer document or a chat attachment', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-b' ? doc({ ...NEWER, lifecycle: 'archived' }) : OLDER,
    )
    expect(await notifyNewFassung(link)).toBe(0)

    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-b' ? doc({ ...NEWER, scope: 'session', projectId: null }) : OLDER,
    )
    expect(await notifyNewFassung(link)).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('drops a recipient who is not in the project of the newer document', async () => {
    assignedTo('anna', 'outsider')
    vi.mocked(userHoldsProjectPermission).mockImplementation(async (_org, _project, userId) => userId !== 'outsider')

    await notifyNewFassung(link)

    expect(emitted().map((item) => item.recipientUserId).sort()).toEqual(['anna', 'uploader'])
    expect(userHoldsProjectPermission).toHaveBeenCalledWith({ organizationId: 'org-1' }, 'p1', 'outsider', 'project:view')
  })

  it('drops a recipient who may not open the folder the newer document is filed in', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-b' ? doc({ ...NEWER, folderId: 'f-restricted' }) : OLDER,
    )
    assignedTo('anna')
    vi.mocked(filterUsersWhoMayReadFolder).mockImplementation(async (_org, _project, folderId, ids) =>
      folderId === 'f-restricted' ? new Set(ids.filter((id) => id === 'anna')) : new Set(ids),
    )

    await notifyNewFassung(link)

    expect(emitted().map((item) => item.recipientUserId)).toEqual(['anna'])
  })

  it('drops a recipient who may not open the older document either', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-a' ? doc({ ...OLDER, folderId: 'f-old' }) : NEWER,
    )
    assignedTo('anna')
    vi.mocked(filterUsersWhoMayReadFolder).mockImplementation(async (_org, _project, folderId, ids) =>
      folderId === 'f-old' ? new Set(ids.filter((id) => id !== 'anna')) : new Set(ids),
    )

    await notifyNewFassung(link)

    expect(emitted().map((item) => item.recipientUserId)).toEqual(['uploader'])
  })

  it('tells nobody when nobody may open the newer document', async () => {
    assignedTo('anna')
    vi.mocked(userHoldsProjectPermission).mockResolvedValue(false)

    expect(await notifyNewFassung(link)).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('reads the Büroablage as organization membership', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      doc({ ...(id === 'doc-b' ? NEWER : OLDER), scope: 'archiv', projectId: null }),
    )
    assignedTo('anna', 'gone')
    vi.mocked(resolveSubjectMembership).mockImplementation(async (_org, userId) =>
      userId === 'gone' ? null : ({ role: 'member', organizationMembershipId: 'm' } as never),
    )

    await notifyNewFassung(link)

    expect(emitted().map((item) => item.recipientUserId).sort()).toEqual(['anna', 'uploader'])
    expect(userHoldsProjectPermission).not.toHaveBeenCalled()
  })

  it('does not tell someone who already holds the item again', async () => {
    assignedTo('anna')
    vi.mocked(recipientsHoldingGroup).mockResolvedValue(new Set(['anna']))

    await notifyNewFassung(link)

    expect(emitted().map((item) => item.recipientUserId)).toEqual(['uploader'])
  })

  it('writes nothing when there is nobody to tell', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-b' ? NEWER : doc({ ...OLDER, createdBy: 'editor' }),
    )

    expect(await notifyNewFassung(link)).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('notifyNewFassung — a same-name version', () => {
  const sameName = {
    organizationId: 'org-1',
    actorUserId: 'editor',
    newerId: 'doc-a',
    olderId: 'doc-a',
    versionId: 'v2',
    previousUploaderIds: ['first-uploader'],
  } as const

  it('tells the document\'s followers, anchored on the new version, naming no second document', async () => {
    assignedTo('anna')

    await notifyNewFassung(sameName)

    const items = emitted()
    expect(items.map((item) => item.recipientUserId).sort()).toEqual(['anna', 'first-uploader', 'uploader'])
    expect(items[0]).toMatchObject({
      type: 'document.new_fassung',
      resourceType: 'document',
      resourceId: 'doc-a',
      anchorId: 'v2',
      payload: { subject: 'Grundriss_A' },
    })
    expect(items[0].payload).not.toHaveProperty('related')
  })

  it('makes a second version a second row', async () => {
    await notifyNewFassung(sameName)
    await notifyNewFassung({ ...sameName, versionId: 'v3' })

    const keys = emitted().map((item) => item.groupKey)
    expect(new Set(keys).size).toBe(2)
  })

  it('says nothing while the document is still held', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(null)

    expect(await notifyNewFassung(sameName)).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('announceNewFassung', () => {
  it('logs and resolves when the announcement fails: it never fails its caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(findDocumentInOrg).mockRejectedValue(new Error('db down'))

    await expect(announceNewFassung(link)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('announceSettledVersions', () => {
  const version = (overrides: Partial<DocumentVersion>): DocumentVersion =>
    ({ id: 'v2', versionNumber: 2, createdBy: 'editor', ...overrides }) as DocumentVersion

  it('announces a document whose published version is not its first, as its uploader', async () => {
    vi.mocked(findPublishedVersion).mockResolvedValue(version({}))
    vi.mocked(findPreviousVersion).mockResolvedValue(version({ id: 'v1', versionNumber: 1, createdBy: 'first-uploader' }))

    await announceSettledVersions('org-1', ['doc-a'])

    expect(emitted().map((item) => item.recipientUserId).sort()).toEqual(['first-uploader', 'uploader'])
    expect(emitted()[0]).toMatchObject({ anchorId: 'v2', actorUserId: 'editor', resourceId: 'doc-a' })
  })

  it('says nothing for a first version', async () => {
    vi.mocked(findPublishedVersion).mockResolvedValue(version({ versionNumber: 1 }))

    await announceSettledVersions('org-1', ['doc-a'])

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('says nothing for a document that is still held, a Piloti document or a missing one', async () => {
    vi.mocked(findPublishedVersion).mockResolvedValue(version({}))
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'held' ? null : id === 'agent' ? doc({ id: 'agent', authoredBy: 'agent' }) : null,
    )

    await announceSettledVersions('org-1', ['held', 'agent', 'unknown'])

    expect(findDocumentInOrg).toHaveBeenCalledWith('held', 'org-1', SCREENED_ONLY)
    expect(findPublishedVersion).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('announceSettledVersions — a link written at ingestion', () => {
  const written = (change: string | null = 'Wand verschoben.\nTür neu.') => ({
    supersededBy: null,
    supersedes: ['Grundriss_A.pdf'],
    suggestion: null,
    change: change ? { text: change, basis: null } : null,
  })

  beforeEach(() => {
    vi.mocked(readFassungNames).mockResolvedValue(written())
    vi.mocked(findFassungCounterparts).mockResolvedValue([
      { id: 'doc-a', filename: 'Grundriss_A.pdf', projectId: 'p1', folderId: null, createdAt: new Date() },
    ])
    vi.mocked(findPublishedVersion).mockResolvedValue(null)
    assignedTo('anna')
  })

  it('announces once on settle: the older document\'s followers, as the newer document\'s uploader, with the first line of what changed', async () => {
    await announceSettledVersions('org-1', ['doc-b'])

    expect(findFassungCounterparts).toHaveBeenCalledWith('org-1', 'proj_abc', ['Grundriss_A.pdf'], SCREENED_ONLY)
    expect(emitted().map((item) => item.recipientUserId).sort()).toEqual(['anna', 'uploader'])
    expect(emitted()[0]).toMatchObject({
      type: 'document.new_fassung',
      resourceId: 'doc-b',
      anchorId: 'doc-a',
      actorUserId: 'editor',
      payload: { subject: 'Grundriss_A', related: 'Grundriss_B', excerpt: 'Wand verschoben.' },
    })
  })

  it('announces nothing on a second settle: those who hold the item are skipped', async () => {
    vi.mocked(recipientsHoldingGroup).mockResolvedValue(new Set(['anna', 'uploader']))

    await announceSettledVersions('org-1', ['doc-b'])

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('reads the collection listing fresh, once per collection, before it looks at the names', async () => {
    await announceSettledVersions('org-1', ['doc-b', 'doc-b'])

    expect(refreshCollectionFiles).toHaveBeenCalledTimes(1)
    expect(refreshCollectionFiles).toHaveBeenCalledWith('proj_abc')
  })

  it('says nothing when the backend lists no replaced document, or the name resolves to nothing screened', async () => {
    vi.mocked(readFassungNames).mockResolvedValue(null)
    await announceSettledVersions('org-1', ['doc-b'])
    vi.mocked(readFassungNames).mockResolvedValue(written())
    vi.mocked(findFassungCounterparts).mockResolvedValue([])
    await announceSettledVersions('org-1', ['doc-b'])

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('never reads the names of a held document, a Piloti document or a chat attachment', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'agent' ? doc({ id: 'agent', authoredBy: 'agent' }) : id === 'chat' ? doc({ id: 'chat', scope: 'session' }) : null,
    )

    await announceSettledVersions('org-1', ['held', 'agent', 'chat'])

    expect(readFassungNames).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('is bounded: only the first 50 documents are looked at', async () => {
    await announceSettledVersions('org-1', Array.from({ length: 80 }, (_, i) => `doc-${i}`))

    expect(findDocumentInOrg).toHaveBeenCalledTimes(50)
  })

  it('does not tell the older document\'s own followers about a link to itself', async () => {
    vi.mocked(findFassungCounterparts).mockResolvedValue([
      { id: 'doc-b', filename: 'Grundriss_B.pdf', projectId: 'p1', folderId: null, createdAt: new Date() },
    ])

    await announceSettledVersions('org-1', ['doc-b'])

    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})
