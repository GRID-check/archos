/**
 * @vitest-environment node
 */
/**
 * A project's Offene Punkte as one Protokoll (`./project-export.ts`), and the
 * service's pure parts (`./project-marks.ts`): what a `due` filter means on
 * the office's day, the cursor's round trip, and how the marks of several
 * documents become one file made of the document Protokoll's own entries.
 * The routes, the gate and the bound are in
 * `app/api/projects/[id]/annotations/route.spec.ts`.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))

import { translatorFor } from '@/i18n/namespace'
import { filesCopy } from '@/i18n/namespaces/files'
import { blocksToMarkdown } from './export'
import { buildProjectProtocol, groupByDocument, selectionLine } from './project-export'
import { decodeProjectMarkCursor, dueRangeOf, encodeProjectMarkCursor } from './project-marks'
import type { ProjectMarkView } from './project-types'
import { PRODUCT_NAME } from '@/lib/brand'

const t = translatorFor(filesCopy, 'de')

const mark = (overrides: Partial<ProjectMarkView> = {}): ProjectMarkView => ({
  id: `${overrides.documentId ?? 'doc_a'}_${overrides.number ?? 1}`,
  documentId: 'doc_a',
  documentName: 'Grundriss EG.pdf',
  number: 1,
  page: 1,
  shape: 'point',
  x: 0.5,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Text',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  revisionNumber: 2,
  onCurrentRevision: true,
  createdBy: 'user_anna',
  createdByName: 'Anna Berger',
  createdAt: '2026-10-07T08:00:00.000Z',
  updatedAt: '2026-10-07T08:00:00.000Z',
  acceptedBy: null,
  acceptedByName: null,
  closedBy: null,
  closedByName: null,
  closedAt: null,
  delegatedBy: null,
  delegatedByName: null,
  delegatedAt: null,
  replies: [],
  canEdit: true,
  canDelete: true,
  ...overrides,
})

describe('dueRangeOf', () => {
  it('reads „überfällig" as before today and „bald" as today through a week ahead', () => {
    expect(dueRangeOf('overdue', '2026-10-18')).toEqual({ before: '2026-10-18' })
    expect(dueRangeOf('soon', '2026-12-28')).toEqual({ from: '2026-12-28', through: '2027-01-04' })
    expect(dueRangeOf(undefined, '2026-10-18')).toBeNull()
  })
})

describe('the cursor', () => {
  it('comes back as it went out, and anything else is a 400', () => {
    const cursor = { due: '9999-12-31', name: 'grundriss „eg“.pdf', documentId: '00000000-0000-4000-8000-000000000001', number: 12 }
    expect(decodeProjectMarkCursor(encodeProjectMarkCursor(cursor))).toEqual(cursor)
    expect(() => decodeProjectMarkCursor('not-a-cursor')).toThrow(expect.objectContaining({ status: 400 }))
  })
})

describe('the project Protokoll', () => {
  const marks = [
    mark({ number: 4, body: 'Lichte Breite der Fluchttür fehlt.', assigneeName: 'Bernd Huber' }),
    mark({ number: 2, body: 'Brandabschnitt prüfen.' }),
    mark({
      number: 5,
      authorKind: 'piloti',
      status: 'proposed',
      body: 'Geländerhöhe unter 1,00 m?',
    }),
    mark({ documentId: 'doc_b', documentName: 'Schnitt A-A.pdf', number: 1, body: 'Höhenkote fehlt.' }),
  ]

  it('groups by document in the order they came, the office’s marks by number and Piloti’s proposals apart', () => {
    const groups = groupByDocument(marks)
    expect(groups.map((group) => group.documentName)).toEqual(['Grundriss EG.pdf', 'Schnitt A-A.pdf'])
    expect(groups[0].selection.marks.map((annotation) => annotation.number)).toEqual([2, 4])
    expect(groups[0].selection.proposals.map((annotation) => annotation.number)).toEqual([5])
  })

  it('is the document Protokoll’s entries under a heading per document, with the filters on the cover', () => {
    const protocol = buildProjectProtocol(
      {
        projectName: 'Wohnhaus Lend',
        selection: selectionLine({ status: 'all-live', assignee: 'me', due: 'overdue' }, 'Anna Berger', t),
        exportedAt: new Date('2026-10-18T07:00:00Z'),
        exportedBy: 'Anna Berger',
      },
      groupByDocument(marks),
      t,
      'de'
    )
    expect(protocol.title).toBe('Offene Punkte – Wohnhaus Lend')
    expect(protocol.facts).toContainEqual({
      label: 'Umfang',
      value: `Offene Anmerkungen und Vorschläge von ${PRODUCT_NAME} · Zuständig: Anna Berger · Frist überfällig`,
    })
    expect(protocol.facts).toContainEqual({ label: 'Dokumente', value: '2' })

    const text = blocksToMarkdown(protocol.body)
    expect(text.indexOf('## Grundriss EG.pdf')).toBeLessThan(text.indexOf('Nr. 2 · Seite 1 · Mangel · offen'))
    expect(text.indexOf('Nr. 2 ·')).toBeLessThan(text.indexOf('Nr. 4 ·'))
    expect(text.indexOf('Nr. 4 ·')).toBeLessThan(text.indexOf(`### Vorschläge von ${PRODUCT_NAME}, nicht geprüft`))
    expect(text.indexOf(`### Vorschläge von ${PRODUCT_NAME}`)).toBeLessThan(text.indexOf('## Schnitt A-A.pdf'))
    expect(text).toContain('**Zuständig:** Bernd Huber')
  })

  it('says so when nothing is in the selection', () => {
    const protocol = buildProjectProtocol(
      { projectName: 'Wohnhaus Lend', selection: 'Offene Anmerkungen', exportedAt: new Date(), exportedBy: 'Anna Berger' },
      [],
      t,
      'de'
    )
    expect(blocksToMarkdown(protocol.body)).toContain('Keine Anmerkungen in dieser Auswahl.')
  })
})
