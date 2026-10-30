/**
 * @vitest-environment node
 */
/**
 * The BCF 3.0 export of a model's Anmerkungen.
 *
 * The file is opened by software nobody here controls, so the assertions are
 * about what a reader refuses or mis-handles: the order of elements (the schema
 * is a `sequence`), a lowercase Guid, `DefaultVisibility` written out (its
 * default is false), an orthographic scale that is the FULL visible height, a
 * Vorschlag that never travels, and bytes that do not change between exports.
 * The archive is read back through the independent zip reader.
 *
 * Every file of a rich archive is validated with `xmllint --schema` against
 * the buildingSMART 3.0 XSDs, vendored unmodified in tests/fixtures/bcf-3.0
 * (CC BY-ND). Without xmllint the check is skipped locally and fails in CI, so
 * it cannot quietly stop running.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readZipEntries } from '@/test-utils/read-zip'
import { bcf3Title, buildAnnotationsBcf3, type Bcf3Input, type Bcf3Topic } from './bcf3-build'

const TOPIC = '5b1a2c3d-0000-4000-8000-000000000001'
const VIEWPOINT = '5b1a2c3d-0000-4000-8000-0000000000a1'
const REPLY = '5b1a2c3d-0000-4000-8000-0000000000b1'
const CARRIED_FROM = '5b1a2c3d-0000-4000-8000-0000000000c1'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])

function topic(overrides: Partial<Bcf3Topic> = {}): Bcf3Topic {
  return {
    id: TOPIC,
    number: 4,
    kind: 'defect',
    status: 'open',
    body: 'Auflager fehlt\nUnterzug & Stützen "EG": Auflager nicht ausgebildet.',
    notes: ['Grundlage: OIB 4, Punkt 2.1'],
    assignedTo: 'max@example.at',
    dueOn: '2026-11-06',
    createdBy: 'anna@example.at',
    createdAt: new Date('2026-10-29T08:15:30.000Z'),
    modified: null,
    replies: [
      {
        id: REPLY,
        author: 'max@example.at',
        date: new Date('2026-10-29T09:00:00.000Z'),
        body: 'Wird im Werkplan ergänzt <ok>',
        editedAt: new Date('2026-10-29T09:05:00.000Z'),
      },
    ],
    viewpoint: {
      id: VIEWPOINT,
      camera: {
        type: 'perspective',
        position: { x: 12.5, y: -8, z: 4.2 },
        direction: { x: 0, y: 1, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        aspectRatio: 1.6,
        fieldOfView: 60,
      },
      clippingPlanes: [{ location: { x: 0, y: 0, z: 1 }, direction: { x: 0, y: 0, z: 1 } }],
      components: {
        selection: { globalIds: ['2O2Fr$t4X7Zf8NOew3FLKU', '1kTvXnbbzCWw8lcMd1dR4o'] },
        visibility: { defaultVisibility: true, exceptions: ['0RSwXnbbzCWw8lcMd1dR9z'] },
        coloring: [{ color: 'ff0000', globalIds: ['2O2Fr$t4X7Zf8NOew3FLKU'] }],
      },
      snapshot: { contentType: 'image/png', bytes: PNG },
    },
    relatedTopicId: CARRIED_FROM,
    ...overrides,
  }
}

const INPUT = (topics: Bcf3Topic[]): Bcf3Input => ({
  model: { filename: 'Haus-A_V3.ifc', ifcProjectGlobalId: '0Yl3Uz1Kv9wxKQ8bqZ3aB1', updatedAt: new Date('2026-10-28T10:00:00.000Z') },
  topics,
})

const read = (topics: Bcf3Topic[]) => readZipEntries(buildAnnotationsBcf3(INPUT(topics)).bytes)

describe('the archive', () => {
  it('names itself 3.0, declares the vocabulary and has one folder per topic', () => {
    const entries = read([topic()])
    expect([...entries.keys()]).toEqual([
      'bcf.version',
      'extensions.xml',
      `${TOPIC}/`,
      `${TOPIC}/markup.bcf`,
      `${TOPIC}/${VIEWPOINT}.bcfv`,
      `${TOPIC}/${VIEWPOINT}.png`,
    ])
    expect(entries.get('bcf.version')).toContain('VersionId="3.0"')
    const extensions = entries.get('extensions.xml') ?? ''
    for (const word of ['Hint', 'Question', 'Defect', 'Open', 'Resolved', 'Dismissed']) {
      expect(extensions).toContain(`>${word}<`)
    }
    expect(extensions).toContain('<User>anna@example.at</User>')
  })

  it('is valid with no topics', () => {
    const built = buildAnnotationsBcf3(INPUT([]))
    expect(built.topics).toBe(0)
    expect([...readZipEntries(built.bytes).keys()]).toEqual(['bcf.version', 'extensions.xml'])
  })

  it('is the same bytes twice, and the snapshot travels untouched', () => {
    const a = buildAnnotationsBcf3(INPUT([topic()])).bytes
    const b = buildAnnotationsBcf3(INPUT([topic()])).bytes
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    expect(Buffer.from(a).includes(Buffer.from(PNG))).toBe(true)
  })

  it('refuses an id that is not a lowercase uuid', () => {
    expect(() => buildAnnotationsBcf3(INPUT([topic({ id: TOPIC.toUpperCase() })]))).toThrow(/lowercase UUID/)
  })
})

describe('the markup', () => {
  const markup = () => read([topic()]).get(`${TOPIC}/markup.bcf`) ?? ''

  it('maps the lifecycle', () => {
    const xml = markup()
    expect(xml).toContain(`<Topic Guid="${TOPIC}" ServerAssignedId="4" TopicType="Defect" TopicStatus="Open">`)
    expect(xml).toContain('<Title>Auflager fehlt</Title>')
    expect(xml).toContain('<AssignedTo>max@example.at</AssignedTo>')
    expect(xml).toContain('<DueDate>2026-11-06T12:00:00Z</DueDate>')
    expect(xml).toContain('<CreationDate>2026-10-29T08:15:30Z</CreationDate>')
    expect(xml).toContain('<CreationAuthor>anna@example.at</CreationAuthor>')
    expect(xml).toContain(`<RelatedTopic Guid="${CARRIED_FROM}" />`)
    expect(xml).toContain('IfcProject="0Yl3Uz1Kv9wxKQ8bqZ3aB1"')
    expect(xml).toContain('<Filename>Haus-A_V3.ifc</Filename>')
  })

  it('puts the whole body and the basis in the description, escaped', () => {
    const xml = markup()
    expect(xml).toContain('Unterzug &amp; Stützen &quot;EG&quot;')
    expect(xml).toContain('Grundlage: OIB 4, Punkt 2.1')
  })

  it('writes the thread as comments, edited ones with their modification', () => {
    const xml = markup()
    expect(xml).toContain(`<Comment Guid="${REPLY}">`)
    expect(xml).toContain('<Comment>Wird im Werkplan ergänzt &lt;ok&gt;</Comment>')
    expect(xml).toContain('<ModifiedDate>2026-10-29T09:05:00Z</ModifiedDate>')
  })

  it('points the viewpoint at its two files', () => {
    const xml = markup()
    expect(xml).toContain(`<ViewPoint Guid="${VIEWPOINT}">`)
    expect(xml).toContain(`<Viewpoint>${VIEWPOINT}.bcfv</Viewpoint>`)
    expect(xml).toContain(`<Snapshot>${VIEWPOINT}.png</Snapshot>`)
  })

  it('keeps the schema order of Topic elements', () => {
    const xml = markup()
    const order = ['<Title>', '<CreationDate>', '<CreationAuthor>', '<DueDate>', '<AssignedTo>', '<Description>', '<RelatedTopics>', '<Comments>', '<Viewpoints>']
    const at = order.map((tag) => xml.indexOf(tag))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('leaves out what it does not have', () => {
    const xml =
      read([topic({ assignedTo: null, dueOn: null, notes: [], body: 'Nur ein Titel', relatedTopicId: null, replies: [], viewpoint: null, status: 'resolved', kind: 'question' })]).get(
        `${TOPIC}/markup.bcf`
      ) ?? ''
    for (const tag of ['AssignedTo', 'DueDate', 'Description', 'RelatedTopics', 'Comments', 'Viewpoints', 'Priority', 'Stage']) {
      expect(xml).not.toContain(`<${tag}`)
    }
    expect(xml).toContain('TopicType="Question" TopicStatus="Resolved"')
  })

  it('omits an IfcProject that is not a 22-character id', () => {
    const built = buildAnnotationsBcf3({ ...INPUT([topic()]), model: { ...INPUT([]).model, ifcProjectGlobalId: 'short' } })
    expect(readZipEntries(built.bytes).get(`${TOPIC}/markup.bcf`)).not.toContain('IfcProject=')
  })

  it('titles by the first non-blank line, cut at 200 characters', () => {
    expect(bcf3Title('\n\n  Zweite Zeile \nrest')).toBe('Zweite Zeile')
    expect(Array.from(bcf3Title('x'.repeat(500))).length).toBe(200)
  })
})

describe('the viewpoint', () => {
  const bcfv = (overrides: Partial<NonNullable<Bcf3Topic['viewpoint']>> = {}) => {
    const base = topic().viewpoint
    if (!base) throw new Error('fixture')
    return read([topic({ viewpoint: { ...base, ...overrides } })]).get(`${TOPIC}/${VIEWPOINT}.bcfv`) ?? ''
  }

  it('orders Components, camera, ClippingPlanes', () => {
    const xml = bcfv()
    const at = ['<Components>', '<PerspectiveCamera>', '<ClippingPlanes>'].map((tag) => xml.indexOf(tag))
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect(xml).toContain(`<VisualizationInfo Guid="${VIEWPOINT}">`)
  })

  it('writes selection, visibility with its default, exceptions and colouring', () => {
    const xml = bcfv()
    expect(xml).toContain('<Component IfcGuid="2O2Fr$t4X7Zf8NOew3FLKU" />')
    expect(xml).toContain('<Visibility DefaultVisibility="true">')
    expect(xml).toMatch(/<Exceptions>\s*<Component IfcGuid="0RSwXnbbzCWw8lcMd1dR9z" \/>/)
    expect(xml).toContain('<Color Color="FF0000">')
  })

  it('writes DefaultVisibility even when nothing is an exception', () => {
    const xml = bcfv({ components: { selection: { globalIds: [] }, visibility: { defaultVisibility: false, exceptions: [] }, coloring: [] } })
    expect(xml).toContain('<Visibility DefaultVisibility="false" />')
    expect(xml).not.toContain('<Selection>')
    expect(xml).not.toContain('<Coloring>')
  })

  it('writes the perspective camera with its vertical field of view', () => {
    const xml = bcfv()
    expect(xml).toMatch(/<CameraViewPoint>\s*<X>12.5<\/X>\s*<Y>-8<\/Y>\s*<Z>4.2<\/Z>/)
    expect(xml).toContain('<FieldOfView>60</FieldOfView>')
    expect(xml).toContain('<AspectRatio>1.6</AspectRatio>')
    expect(xml).not.toContain('OrthogonalCamera')
  })

  it('writes the orthographic scale as stored: the FULL visible height', () => {
    const base = topic().viewpoint
    if (!base) throw new Error('fixture')
    const xml = bcfv({ camera: { type: 'orthographic', position: base.camera.position, direction: base.camera.direction, up: base.camera.up, aspectRatio: 2, viewToWorldScale: 25 } })
    expect(xml).toContain('<ViewToWorldScale>25</ViewToWorldScale>')
    expect(xml).not.toContain('PerspectiveCamera')
  })

  it('writes the section with the direction toward the hidden half', () => {
    expect(bcfv()).toMatch(/<ClippingPlane>\s*<Location>[\s\S]*<\/Location>\s*<Direction>\s*<X>0<\/X>\s*<Y>0<\/Y>\s*<Z>1<\/Z>/)
  })

  it('writes no negative zero', () => {
    const base = topic().viewpoint
    if (!base) throw new Error('fixture')
    expect(bcfv({ camera: { ...base.camera, direction: { x: -0, y: 1, z: 0 } } })).not.toContain('-0<')
  })
})

const XSD_DIR = resolve(__dirname, '../../tests/fixtures/bcf-3.0')

function hasXmllint(): boolean {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const XMLLINT = hasXmllint()

describe('the schema check itself', () => {
  it('runs in CI', () => {
    if (process.env.CI) expect(XMLLINT, 'xmllint is missing on the CI runner (install libxml2-utils)').toBe(true)
  })
})

describe.skipIf(!XMLLINT)('against the buildingSMART 3.0 schemas', () => {
  it('validates every file of a rich archive', () => {
    const dir = XSD_DIR
    const work = mkdtempSync(join(tmpdir(), 'bcf3-'))
    try {
      const orthographic = topic({
        id: '5b1a2c3d-0000-4000-8000-000000000002',
        number: 5,
        status: 'dismissed',
        kind: 'hint',
        replies: [],
        relatedTopicId: null,
        viewpoint: { ...(topic().viewpoint as NonNullable<Bcf3Topic['viewpoint']>), id: '5b1a2c3d-0000-4000-8000-0000000000a2', camera: { type: 'orthographic', position: { x: 0, y: 0, z: 30 }, direction: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 }, aspectRatio: 1.5, viewToWorldScale: 24 }, snapshot: null },
      })
      const entries = readZipEntries(buildAnnotationsBcf3(INPUT([topic(), orthographic])).bytes)
      const schemas: [RegExp, string][] = [
        [/markup\.bcf$/, 'markup.xsd'],
        [/\.bcfv$/, 'visinfo.xsd'],
        [/^extensions\.xml$/, 'extensions.xsd'],
        [/^bcf\.version$/, 'version.xsd'],
      ]
      let checked = 0
      for (const [path, content] of entries) {
        const schema = schemas.find(([pattern]) => pattern.test(path))
        if (!schema) continue
        const file = join(work, `${checked}.xml`)
        writeFileSync(file, content)
        execFileSync('xmllint', ['--noout', '--schema', join(dir, schema[1]), file], { stdio: 'pipe' })
        checked += 1
      }
      expect(checked).toBe(6)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
