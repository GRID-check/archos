import { describe, expect, it } from 'vitest'
import { EMPTY_FASSUNG } from '@/lib/documents/fassung'
import type { DocumentVersionState, DocumentVersionView } from '@/lib/documents/lifecycle-types'
import {
  bornPublished,
  buildFassungTimeline,
  changeLines,
  fassungTag,
  hasLinkedFassungen,
  isPendingVersion,
  latestAct,
  numberOfVersion,
  ownNewestRow,
  showsFassungenSection,
  versionActs,
  type TimelineRow,
} from './fassung-timeline'

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
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
  ...overrides,
})

const linked = (id: string, createdAt: string | null) => ({ id, filename: `${id}.pdf`, createdAt, changeSummary: null })

const ids = (rows: TimelineRow[]): string[] =>
  rows.map((row) =>
    row.kind === 'version'
      ? `v${row.version.versionNumber}`
      : row.kind === 'linked'
        ? row.entry.id
        : row.kind === 'newer'
          ? `newer:${row.ref.id}`
          : 'head',
  )

const build = (overrides: Partial<Parameters<typeof buildFassungTimeline>[0]> = {}) =>
  buildFassungTimeline({
    versions: [],
    publishedVersionId: null,
    history: [],
    directIds: new Set(),
    headAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  })

describe('buildFassungTimeline', () => {
  it('stands in for the document itself when its versions are not known', () => {
    expect(ids(build({ history: [linked('a', '2026-06-01T00:00:00Z')] }))).toEqual(['head', 'a'])
  })

  it('merges uploads and linked documents by date, newest first', () => {
    const rows = build({
      versions: [
        version(1, 'superseded', { createdAt: '2026-06-15T00:00:00Z' }),
        version(2, 'published', { createdAt: '2026-08-01T00:00:00Z' }),
      ],
      publishedVersionId: 'ver_2',
      history: [linked('a', '2026-06-01T00:00:00Z'), linked('b', '2026-07-02T00:00:00Z')],
    })

    expect(ids(rows)).toEqual(['v2', 'b', 'v1', 'a'])
  })

  it('marks the published upload current and the highest number newest, whatever its state', () => {
    const rows = build({
      versions: [version(1, 'published', { createdAt: '2026-08-01T00:00:00Z' }), version(2, 'in_review', { createdAt: '2026-09-01T00:00:00Z' })],
      publishedVersionId: 'ver_1',
    })

    const [pending, published] = rows
    expect(pending).toMatchObject({ kind: 'version', current: false, newest: true })
    expect(published).toMatchObject({ kind: 'version', current: true, newest: false })
  })

  it('pairs each upload with its true predecessor by number, and the oldest with none', () => {
    const rows = build({ versions: [version(3, 'published'), version(1, 'superseded'), version(2, 'superseded')] })

    expect(rows.map((row) => (row.kind === 'version' ? row.predecessor?.versionNumber ?? null : 'x'))).toEqual([2, 1, null])
  })

  it('puts a row without a date last, in the order it came', () => {
    const rows = build({
      versions: [version(1, 'published', { createdAt: '2026-08-01T00:00:00Z' })],
      history: [linked('x', null), linked('a', '2026-06-01T00:00:00Z'), linked('y', null)],
    })

    expect(ids(rows)).toEqual(['v1', 'a', 'x', 'y'])
  })

  it('puts the upload before the link on the same instant, and uploads among themselves by number', () => {
    const at = '2026-08-01T00:00:00Z'
    const rows = build({
      versions: [version(1, 'superseded', { createdAt: at }), version(2, 'published', { createdAt: at })],
      history: [linked('a', at)],
    })

    expect(ids(rows)).toEqual(['v2', 'v1', 'a'])
  })

  it('numbers every Fassung newest first, across uploads and linked documents alike', () => {
    const rows = build({
      versions: [
        version(1, 'superseded', { createdAt: '2026-06-15T00:00:00Z' }),
        version(2, 'published', { createdAt: '2026-08-01T00:00:00Z' }),
      ],
      publishedVersionId: 'ver_2',
      history: [linked('a', '2026-06-01T00:00:00Z'), linked('b', '2026-07-02T00:00:00Z')],
    })

    // A place in this list, not the stored versionNumber (which counts only the uploads).
    expect(rows.map((row) => [ids([row])[0], row.number])).toEqual([
      ['v2', 4],
      ['b', 3],
      ['v1', 2],
      ['a', 1],
    ])
    expect(numberOfVersion(rows, 'ver_1')).toBe(2)
    expect(numberOfVersion(rows, 'nope')).toBeNull()
    expect(ownNewestRow(rows)).toMatchObject({ kind: 'version', number: 4 })
  })

  it('puts the newer document that replaced this one on top, current, and no own row current', () => {
    const rows = build({
      versions: [version(1, 'published', { createdAt: '2026-07-01T00:00:00Z' })],
      publishedVersionId: 'ver_1',
      history: [linked('a', '2026-06-01T00:00:00Z')],
      newer: { id: 'doc_c', filename: 'EG_Index_C.pdf' },
    })

    expect(ids(rows)).toEqual(['newer:doc_c', 'v1', 'a'])
    expect(rows.map((row) => row.number)).toEqual([3, 2, 1])
    expect(rows.filter((row) => (row.kind === 'version' || row.kind === 'head') && row.current)).toEqual([])
    expect(build({ newer: { id: 'doc_c', filename: 'c.pdf' } })[1]).toMatchObject({ kind: 'head', current: false })
  })

  it('knows which linked documents this one replaces directly', () => {
    const rows = build({ history: [linked('a', '2026-06-01T00:00:00Z'), linked('b', '2026-07-01T00:00:00Z')], directIds: new Set(['b']) })

    expect(rows.flatMap((row) => (row.kind === 'linked' ? [[row.entry.id, row.direct]] : []))).toEqual([
      ['b', true],
      ['a', false],
    ])
  })
})

describe('versionActs / latestAct', () => {
  it('says a one-step approval once, as the approval it was', () => {
    const at = '2026-09-03T10:00:00.000Z'
    const approved = version(2, 'published', {
      submittedBy: 'user_author',
      submittedAt: '2026-09-02T10:00:00.000Z',
      approvedBy: 'user_markus',
      approvedAt: at,
      publishedBy: 'user_markus',
      publishedAt: at,
    })
    expect(versionActs(approved).map((act) => act.key)).toEqual(['submitted', 'approved'])
    expect(latestAct(approved)).toMatchObject({ key: 'approved', actor: 'user_markus' })
  })

  const stamped = {
    submittedBy: 'user_a',
    submittedAt: '2026-09-02T09:00:00Z',
    reviewedBy: 'user_r',
    reviewedAt: '2026-09-03T10:00:00Z',
  }

  it('reports the milestones in the order they happen', () => {
    const acts = versionActs(
      version(2, 'published', { ...stamped, approvedBy: 'user_r', approvedAt: '2026-09-03T10:00:00Z', publishedBy: 'user_r', publishedAt: '2026-09-04T10:00:00Z' }),
    )

    expect(acts.map((act) => act.key)).toEqual(['submitted', 'approved', 'published'])
  })

  it('adds the refusal that stopped a version, with who and when', () => {
    expect(versionActs(version(2, 'changes_requested', stamped)).map((act) => act.key)).toEqual(['submitted', 'changesRequested'])
    expect(versionActs(version(2, 'rejected', stamped)).map((act) => act.key)).toEqual(['submitted', 'rejected'])
  })

  it('never reads an approval as a refusal: the review columns are stamped by both', () => {
    const acts = versionActs(version(2, 'approved', { ...stamped, approvedBy: 'user_r', approvedAt: '2026-09-03T10:00:00Z' }))

    expect(acts.map((act) => act.key)).toEqual(['submitted', 'approved'])
  })

  it('reports no approval for an upload that was born published, only the upload itself', () => {
    // The server stamps the uploader as approver and publisher to satisfy the CHECK (ADR-0054).
    const upload = version(1, 'published', {
      approvedBy: 'user_author',
      approvedAt: '2026-09-01T08:00:00.000Z',
      publishedBy: 'user_author',
      publishedAt: '2026-09-01T08:00:00.000Z',
    })

    expect(bornPublished(upload)).toBe(true)
    expect(bornPublished({ ...upload, state: 'superseded' })).toBe(true)
    expect(bornPublished({ ...upload, submittedBy: 'user_a' })).toBe(false)
    expect(bornPublished({ ...upload, state: 'in_review' })).toBe(false)
    expect(versionActs(upload)).toEqual([])
    expect(latestAct(upload)).toEqual({ key: 'uploaded', actor: 'user_author', when: '2026-09-01T08:00:00.000Z' })
  })

  it('names the upload when nothing has happened to the version since it arrived', () => {
    expect(latestAct(version(1, 'published'))).toEqual({ key: 'uploaded', actor: 'user_author', when: '2026-09-01T08:00:00.000Z' })
  })

  it('names the latest act otherwise', () => {
    expect(latestAct(version(2, 'changes_requested', stamped))).toMatchObject({ key: 'changesRequested', actor: 'user_r' })
  })
})

describe('what is pending, and when the section is drawn', () => {
  it('counts a version nobody has published or ended as pending', () => {
    expect(
      (['draft', 'in_review', 'changes_requested', 'approved'] as const).every((state) => isPendingVersion({ state })),
    ).toBe(true)
    expect((['published', 'superseded', 'rejected'] as const).some((state) => isPendingVersion({ state }))).toBe(false)
  })

  it('draws for a reader with review rights, whatever the document has', () => {
    expect(showsFassungenSection({ facts: null, versionCount: 1, hasViewer: true })).toBe(true)
  })

  it('draws for anyone when there is a history, and for no one when there is none', () => {
    expect(showsFassungenSection({ facts: null, versionCount: 1, hasViewer: false })).toBe(false)
    expect(showsFassungenSection({ facts: EMPTY_FASSUNG, versionCount: null, hasViewer: false })).toBe(false)
    expect(showsFassungenSection({ facts: null, versionCount: 3, hasViewer: false })).toBe(true)
    expect(
      showsFassungenSection({ facts: { ...EMPTY_FASSUNG, supersedes: [{ id: 'a', filename: 'a.pdf' }] }, versionCount: 1, hasViewer: false }),
    ).toBe(true)
  })

  it('counts a suggestion and a change summary as something to show', () => {
    expect(hasLinkedFassungen({ ...EMPTY_FASSUNG, changeSummary: { text: '- x', basis: 'previous' } })).toBe(true)
    expect(hasLinkedFassungen(EMPTY_FASSUNG)).toBe(false)
  })
})

describe('fassungTag — the index first, else the date, title block before name', () => {
  it('reads the index off the name, a letter as „Index", a number as „v"', () => {
    expect(fassungTag('EG_Index_C_2026-08-14.pdf')).toEqual({ kind: 'index', text: 'Index C' })
    expect(fassungTag('Schnitt_v3.pdf')).toEqual({ kind: 'index', text: 'v3' })
  })

  it('falls back to the date when the name has no index, and to null when it has neither', () => {
    expect(fassungTag('Grundriss_2026-08-14.pdf')).toEqual({ kind: 'date', text: '14.08.2026' })
    expect(fassungTag('Aktenvermerk.pdf')).toBeNull()
  })

  it('prefers what the title block printed to what the name says', () => {
    expect(fassungTag('EG_Index_B_2026-07-02.pdf', { revision: 'C' })).toEqual({ kind: 'index', text: 'Index C' })
    expect(fassungTag('x.pdf', { revision: 'Index D' })).toEqual({ kind: 'index', text: 'Index D' })
    expect(fassungTag('scan.pdf', { revisionDate: '2026-08-14' })).toEqual({ kind: 'date', text: '14.08.2026' })
    expect(fassungTag('scan.pdf', { revisionDate: 'Aug 2026' })).toEqual({ kind: 'date', text: 'Aug 2026' })
    expect(fassungTag('EG_Index_C_2026-08-14.pdf', { revision: ' ' })).toEqual({ kind: 'index', text: 'Index C' })
  })
})

describe('labels and change lines', () => {
  it('drops bullet markers and blank lines but keeps a line that merely starts with a digit', () => {
    expect(changeLines('- Dachhöhe\n• Fenster\n\n2) Attika neu\n– Entwässerung\n*  Brüstung')).toEqual([
      'Dachhöhe',
      'Fenster',
      'Attika neu',
      'Entwässerung',
      'Brüstung',
    ])
    expect(changeLines('\n  \n2026 Entwurf\n')).toEqual(['2026 Entwurf'])
  })
})
