import { describe, expect, it } from 'vitest'
import type { DocumentReadFamily } from '@/lib/documents/document-status'
import type { DocumentVersionState, DocumentVersionView } from '@/lib/documents/lifecycle-types'
import { revisionStanding, resolvePerson } from './revision-standing'
import { buildRevisionTimeline } from './revision-timeline'

const version = (
  versionNumber: number,
  state: DocumentVersionState,
  overrides: Partial<DocumentVersionView> = {},
): DocumentVersionView => ({
  id: `ver_${versionNumber}`,
  documentId: 'doc_1',
  versionNumber,
  state,
  contentType: null,
  fileSize: null,
  contentHash: null,
  submittedBy: null,
  submittedAt: null,
  reviewedBy: null,
  reviewedAt: null,
  approvedBy: null,
  approvedAt: null,
  publishedBy: null,
  publishedAt: null,
  reviewComment: null,
  createdBy: 'user_author',
  createdAt: `2026-09-0${versionNumber}T08:00:00.000Z`,
  updatedAt: `2026-09-0${versionNumber}T08:00:00.000Z`,
  ...overrides,
})

/** A person's upload as the server stores it: born published, the uploader standing in as approver. */
const upload = (versionNumber: number, state: DocumentVersionState = 'published') =>
  version(versionNumber, state, { approvedBy: 'user_author', publishedBy: 'user_author' })

const reviewed = (versionNumber: number, state: DocumentVersionState, overrides: Partial<DocumentVersionView> = {}) =>
  version(versionNumber, state, { submittedBy: 'user_author', submittedAt: '2026-09-01T09:00:00.000Z', ...overrides })

const REVIEWER = { permissions: ['project:view', 'project:edit'] as const, userId: 'user_me' }
const WRITER = { permissions: ['project:view', 'project:documents:write'] as const, userId: 'user_me' }

function standingOf(
  versions: DocumentVersionView[],
  options: {
    history?: { id: string; filename: string; createdAt: string | null; changeSummary: string | null }[]
    newer?: { id: string; filename: string }
    reviewerUserIds?: string[]
    viewer?: typeof REVIEWER | typeof WRITER
    lifecycle?: 'active' | 'archived'
    read?: DocumentReadFamily
    agent?: boolean
  } = {},
) {
  const rows = buildRevisionTimeline({
    versions,
    publishedVersionId: versions.find((row) => row.state === 'published')?.id ?? null,
    history: options.history ?? [],
    directIds: new Set(),
    headAt: '2026-08-01T00:00:00.000Z',
    newer: options.newer ?? null,
    newestRead: options.read,
    predecessorStandsIn: !options.agent,
  })
  const newest = versions.reduce<DocumentVersionView | null>(
    (best, row) => (best === null || row.versionNumber > best.versionNumber ? row : best),
    null,
  )
  return revisionStanding({
    rows,
    newest,
    lifecycle: options.lifecycle ?? 'active',
    reviewerUserIds: options.reviewerUserIds,
    viewer: options.viewer,
    newestRead: options.read,
  })
}

describe('revisionStanding — the header describes the newest Fassung', () => {
  it('says a round in review is waiting while Piloti still answers from the older published Fassung, by number', () => {
    const standing = standingOf([reviewed(1, 'published', { approvedBy: 'user_r', publishedBy: 'user_r' }), reviewed(2, 'in_review')])

    expect(standing).toMatchObject({ number: 2, state: 'in_review', answer: { kind: 'older', number: 1 } })
    expect(standing.progress).toMatchObject({ reached: 2, tone: 'moving' })
    expect(standing.stage).toBe(1)
  })

  it('counts linked older documents into the number the header names', () => {
    const standing = standingOf([reviewed(1, 'published'), reviewed(2, 'in_review')], {
      history: [{ id: 'doc_a', filename: 'EG_Index_A.pdf', createdAt: '2026-06-01T00:00:00Z', changeSummary: null }],
    })

    expect(standing).toMatchObject({ number: 3, answer: { kind: 'older', number: 2 } })
  })

  it('does not point at a published Fassung when there is none', () => {
    expect(standingOf([reviewed(1, 'in_review')]).answer).toEqual({ kind: 'notYet' })
    expect(standingOf([reviewed(1, 'rejected')]).answer).toEqual({ kind: 'never' })
    expect(standingOf([reviewed(1, 'published'), reviewed(2, 'rejected')]).answer).toEqual({ kind: 'older', number: 1 })
  })

  it('gives a published Fassung that went through review its state and a settled track', () => {
    const standing = standingOf([reviewed(1, 'published', { approvedBy: 'user_r', publishedBy: 'user_r' })])

    expect(standing).toMatchObject({ state: 'published', answer: { kind: 'this' }, nextStep: null, stage: 3 })
    expect(standing.progress).toMatchObject({ reached: 4, tone: 'settled' })
  })
})

describe('revisionStanding — no fake approval', () => {
  it('gives a plain upload no state word and no track, and says Piloti answers from it', () => {
    const standing = standingOf([upload(1)])

    expect(standing).toMatchObject({ number: 1, state: null, progress: null, stage: null, nextStep: null, answer: { kind: 'this' } })
  })

  it('treats a re-upload as an upload, even when an earlier Fassung was reviewed', () => {
    expect(standingOf([reviewed(1, 'superseded'), upload(2)])).toMatchObject({ state: null, progress: null })
  })

  it('calls a Fassung a newer document replaced „Ersetzt", with no track, and points at the newer one', () => {
    const standing = standingOf([reviewed(1, 'published')], { newer: { id: 'doc_c', filename: 'EG_Index_C.pdf' } })

    expect(standing).toMatchObject({ number: 1, state: 'superseded', progress: null, nextStep: null, answer: { kind: 'newer', number: 2 } })
  })

  it('says a retired document is retired, whatever its versions reached', () => {
    expect(standingOf([reviewed(1, 'published')], { lifecycle: 'archived' })).toMatchObject({
      state: 'archived',
      progress: null,
      nextStep: null,
      answer: { kind: 'retired' },
    })
  })

  it('answers from the document itself when its versions were not read', () => {
    expect(standingOf([])).toMatchObject({ number: 1, state: null, progress: null, answer: { kind: 'this' } })
  })
})

describe('revisionStanding — published is not yet answerable until it has been read', () => {
  it('keeps answering from the previous upload while a re-upload is read, and after its reading failed', () => {
    for (const read of ['reading', 'failed', 'held'] as const) {
      expect(standingOf([upload(1, 'superseded'), upload(2)], { read }).answer).toEqual({ kind: 'older', number: 1 })
    }
  })

  it('says a first upload answers once read, and not at all when its reading failed', () => {
    expect(standingOf([upload(1)], { read: 'reading' }).answer).toEqual({ kind: 'notYetRead' })
    expect(standingOf([upload(1)], { read: 'failed' }).answer).toEqual({ kind: 'never' })
    expect(standingOf([], { read: 'reading' }).answer).toEqual({ kind: 'notYetRead' })
  })

  it('does not lean on the previous Fassung of a Piloti document, whose publish removed it first', () => {
    const versions = [reviewed(1, 'superseded'), reviewed(2, 'published')]
    expect(standingOf(versions, { read: 'reading', agent: true }).answer).toEqual({ kind: 'notYetRead' })
    expect(standingOf(versions, { read: 'failed', agent: true }).answer).toEqual({ kind: 'never' })
  })

  it('leaves a review waiting on the newest alone: the reading status is about the published one then', () => {
    const versions = [reviewed(1, 'published'), reviewed(2, 'in_review')]
    expect(standingOf(versions, { read: 'reading' }).answer).toEqual({ kind: 'older', number: 1 })
  })
})

describe('revisionStanding — the next step, with a person', () => {
  it('names the people the round was sent to', () => {
    expect(standingOf([reviewed(1, 'in_review')], { reviewerUserIds: ['user_sabine'], viewer: REVIEWER }).nextStep).toEqual({
      kind: 'approve',
      people: ['user_sabine'],
      you: false,
    })
  })

  it('says it is the reader’s own approval when the round was sent to them', () => {
    expect(
      standingOf([reviewed(1, 'in_review')], { reviewerUserIds: ['user_me', 'user_sabine'], viewer: REVIEWER }).nextStep,
    ).toEqual({ kind: 'approve', people: ['user_sabine'], you: true })
  })

  it('falls back to the reader when the round names nobody and they may approve, and to nobody otherwise', () => {
    expect(standingOf([reviewed(1, 'in_review')], { viewer: REVIEWER }).nextStep).toMatchObject({ people: [], you: true })
    expect(standingOf([reviewed(1, 'in_review')], { viewer: WRITER }).nextStep).toMatchObject({ people: [], you: false })
    // The submitter may not approve their own round.
    expect(
      standingOf([reviewed(1, 'in_review', { submittedBy: 'user_me' })], { viewer: REVIEWER }).nextStep,
    ).toMatchObject({ people: [], you: false })
  })

  it('sends a Fassung with changes requested back to whoever submitted it', () => {
    const stopped = reviewed(2, 'changes_requested', { submittedBy: 'user_anna', reviewedBy: 'user_clara' })
    expect(standingOf([reviewed(1, 'published'), stopped], { viewer: WRITER })).toMatchObject({
      nextStep: { kind: 'revise', people: ['user_anna'], you: false },
      stage: 0,
      progress: { halted: true, tone: 'stopped' },
    })
    expect(standingOf([stopped], { viewer: { ...WRITER, userId: 'user_anna' } }).nextStep).toMatchObject({ you: true })
  })

  it('asks the author of a draft to submit it, and a reader who may publish to publish an approved one', () => {
    expect(standingOf([version(1, 'draft', { createdBy: 'user_anna' })]).nextStep).toEqual({
      kind: 'submit',
      people: ['user_anna'],
      you: false,
    })
    expect(standingOf([reviewed(1, 'approved')], { viewer: WRITER }).nextStep).toEqual({ kind: 'publish', people: [], you: true })
    expect(standingOf([reviewed(1, 'approved')]).nextStep).toEqual({ kind: 'publish', people: [], you: false })
  })
})

describe('resolvePerson — a name, never an id, and „ein Teammitglied" only when truly unknown', () => {
  const listed = new Map([['user_anna', 'Anna Berger']])
  const assignees = new Map([['user_markus', 'Markus Feld']])

  it('says „you" for the reader, before any name', () => {
    expect(resolvePerson('user_me', 'user_me', new Map([['user_me', 'Miriam Hofer']]))).toEqual({ kind: 'you' })
  })

  it('takes the first source that knows the person', () => {
    expect(resolvePerson('user_anna', 'user_me', listed, assignees)).toEqual({ kind: 'name', name: 'Anna Berger' })
    expect(resolvePerson('user_markus', 'user_me', listed, assignees)).toEqual({ kind: 'name', name: 'Markus Feld' })
  })

  it('is unknown for an id nobody can name, a blank name, or no id at all', () => {
    expect(resolvePerson('user_ghost', 'user_me', listed, assignees)).toEqual({ kind: 'unknown' })
    expect(resolvePerson('user_blank', 'user_me', new Map([['user_blank', '  ']]))).toEqual({ kind: 'unknown' })
    expect(resolvePerson(null, 'user_me', listed)).toEqual({ kind: 'unknown' })
  })
})
