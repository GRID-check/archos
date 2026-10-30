/**
 * @vitest-environment happy-dom
 */
/**
 * Round trip of the BCF 3.0 export on our own output: build an archive, unzip
 * it with the independent reader, parse every XML file as XML (not by string
 * search), and read each field back by its BCF 3.0 element name. What comes
 * back must equal what went in: camera, clipping plane, selection, visibility,
 * colouring, snapshot bytes, comment, assignee and due date. This is the
 * reader F3's import will grow from; the golden here is the input itself.
 */

import { describe, expect, it } from 'vitest'
import { readZipFiles } from '@/test-utils/read-zip'
import type { ClippingPlane, Vec3, ViewpointCamera } from '@/lib/annotations/viewpoint-types'
import { buildAnnotationsBcf3, type Bcf3Topic } from './bcf3-build'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128, 7])

const perspective: Bcf3Topic = {
  id: '7c1a2c3d-0000-4000-8000-000000000001',
  number: 1,
  kind: 'defect',
  status: 'open',
  body: 'Auflager fehlt\nUnterzug ohne Auflager.',
  notes: [],
  assignedTo: 'max@example.at',
  dueOn: '2026-11-06',
  createdBy: 'anna@example.at',
  createdAt: new Date('2026-10-29T08:15:30.000Z'),
  modified: null,
  replies: [
    { id: '7c1a2c3d-0000-4000-8000-0000000000b1', author: 'max@example.at', date: new Date('2026-10-29T09:00:00.000Z'), body: 'Kommt im Werkplan & <bald>', editedAt: null },
  ],
  viewpoint: {
    id: '7c1a2c3d-0000-4000-8000-0000000000a1',
    camera: { type: 'perspective', position: { x: 2501234.125, y: -8.5, z: 4.2 }, direction: { x: 0.6, y: 0.8, z: 0 }, up: { x: 0, y: 0, z: 1 }, aspectRatio: 1.6, fieldOfView: 45.5 },
    clippingPlanes: [{ location: { x: 0, y: 0, z: 1 }, direction: { x: 0, y: 0, z: 1 } }],
    components: {
      selection: { globalIds: ['2O2Fr$t4X7Zf8NOew3FLKU', '1kTvXnbbzCWw8lcMd1dR4o'] },
      visibility: { defaultVisibility: true, exceptions: ['0RSwXnbbzCWw8lcMd1dR9z'] },
      coloring: [{ color: 'FF0000', globalIds: ['2O2Fr$t4X7Zf8NOew3FLKU'] }],
    },
    snapshot: { contentType: 'image/png', bytes: PNG },
  },
  relatedTopicId: '7c1a2c3d-0000-4000-8000-0000000000c1',
}

const orthographic: Bcf3Topic = {
  ...perspective,
  id: '7c1a2c3d-0000-4000-8000-000000000002',
  number: 2,
  kind: 'question',
  status: 'resolved',
  replies: [],
  relatedTopicId: null,
  viewpoint: {
    id: '7c1a2c3d-0000-4000-8000-0000000000a2',
    camera: { type: 'orthographic', position: { x: 0, y: 0, z: 30 }, direction: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 }, aspectRatio: 1.5, viewToWorldScale: 24 },
    clippingPlanes: [],
    components: { selection: { globalIds: [] }, visibility: { defaultVisibility: false, exceptions: ['1kTvXnbbzCWw8lcMd1dR4o'] }, coloring: [] },
    snapshot: null,
  },
}

const parse = (bytes: Uint8Array | undefined): Document => {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('not well-formed')
  return doc
}

const children = (parent: Element, tag: string): Element[] => Array.from(parent.children).filter((child) => child.tagName === tag)
const child = (parent: Element, tag: string): Element | undefined => children(parent, tag)[0]
const textOf = (parent: Element, tag: string): string | null => child(parent, tag)?.textContent ?? null

const vec = (parent: Element, tag: string): Vec3 => {
  const node = child(parent, tag)
  if (!node) throw new Error(`no ${tag}`)
  return { x: Number(textOf(node, 'X')), y: Number(textOf(node, 'Y')), z: Number(textOf(node, 'Z')) }
}

const guids = (parent: Element | undefined): string[] =>
  parent ? children(parent, 'Component').map((component) => component.getAttribute('IfcGuid') ?? '') : []

function readCamera(root: Element): ViewpointCamera {
  const ortho = child(root, 'OrthogonalCamera')
  const node = ortho ?? child(root, 'PerspectiveCamera')
  if (!node) throw new Error('no camera')
  const shared = { position: vec(node, 'CameraViewPoint'), direction: vec(node, 'CameraDirection'), up: vec(node, 'CameraUpVector'), aspectRatio: Number(textOf(node, 'AspectRatio')) }
  return ortho
    ? { type: 'orthographic', ...shared, viewToWorldScale: Number(textOf(node, 'ViewToWorldScale')) }
    : { type: 'perspective', ...shared, fieldOfView: Number(textOf(node, 'FieldOfView')) }
}

function readViewpoint(bcfv: Document, snapshotBytes: Uint8Array | null): NonNullable<Bcf3Topic['viewpoint']> {
  const root = bcfv.documentElement
  const components = child(root, 'Components')
  const visibility = components && child(components, 'Visibility')
  const planes = child(root, 'ClippingPlanes')
  const coloring = components && child(components, 'Coloring')
  return {
    id: root.getAttribute('Guid') ?? '',
    camera: readCamera(root),
    clippingPlanes: planes ? children(planes, 'ClippingPlane').map((plane): ClippingPlane => ({ location: vec(plane, 'Location'), direction: vec(plane, 'Direction') })) : [],
    components: {
      selection: { globalIds: guids(components && child(components, 'Selection')) },
      visibility: { defaultVisibility: visibility?.getAttribute('DefaultVisibility') === 'true', exceptions: guids(visibility && child(visibility, 'Exceptions')) },
      coloring: coloring
        ? children(coloring, 'Color').map((color) => ({ color: color.getAttribute('Color') ?? '', globalIds: guids(child(color, 'Components')) }))
        : [],
    },
    snapshot: snapshotBytes ? { contentType: 'image/png', bytes: snapshotBytes } : null,
  }
}

const TYPES: Record<string, Bcf3Topic['kind']> = { Hint: 'hint', Question: 'question', Defect: 'defect' }
const STATUSES: Record<string, Bcf3Topic['status']> = { Open: 'open', Resolved: 'resolved', Dismissed: 'dismissed' }

/** The fields of one topic folder, read back by BCF name. */
function readTopic(files: Map<string, Uint8Array>, folder: string) {
  const topic = parse(files.get(`${folder}/markup.bcf`)).getElementsByTagName('Topic')[0]
  const viewPoint = child(child(topic, 'Viewpoints') ?? topic, 'ViewPoint')
  const bcfvName = viewPoint && textOf(viewPoint, 'Viewpoint')
  const snapshotName = viewPoint && textOf(viewPoint, 'Snapshot')
  const comments = child(topic, 'Comments')
  return {
    id: topic.getAttribute('Guid'),
    number: Number(topic.getAttribute('ServerAssignedId')),
    kind: TYPES[topic.getAttribute('TopicType') ?? ''],
    status: STATUSES[topic.getAttribute('TopicStatus') ?? ''],
    title: textOf(topic, 'Title'),
    assignedTo: textOf(topic, 'AssignedTo'),
    dueOn: textOf(topic, 'DueDate')?.slice(0, 10) ?? null,
    createdBy: textOf(topic, 'CreationAuthor'),
    createdAt: textOf(topic, 'CreationDate'),
    replies: comments
      ? children(comments, 'Comment').map((comment) => ({ id: comment.getAttribute('Guid'), author: textOf(comment, 'Author'), date: textOf(comment, 'Date'), body: textOf(comment, 'Comment') }))
      : [],
    relatedTopicId: child(child(topic, 'RelatedTopics') ?? topic, 'RelatedTopic')?.getAttribute('Guid') ?? null,
    viewpoint: bcfvName ? readViewpoint(parse(files.get(`${folder}/${bcfvName}`)), snapshotName ? (files.get(`${folder}/${snapshotName}`) ?? null) : null) : null,
  }
}

describe('a BCF 3.0 archive read back', () => {
  const files = readZipFiles(
    buildAnnotationsBcf3({
      model: { filename: 'Haus-A.ifc', ifcProjectGlobalId: null, updatedAt: new Date('2026-10-28T10:00:00.000Z') },
      topics: [perspective, orthographic],
    }).bytes
  )

  it.each([
    ['perspective', perspective],
    ['orthographic', orthographic],
  ])('gives back the %s topic that went in', (_, topic) => {
    const back = readTopic(files, topic.id)
    expect(back).toEqual({
      id: topic.id,
      number: topic.number,
      kind: topic.kind,
      status: topic.status,
      title: 'Auflager fehlt',
      assignedTo: topic.assignedTo,
      dueOn: topic.dueOn,
      createdBy: topic.createdBy,
      createdAt: '2026-10-29T08:15:30Z',
      replies: topic.replies.map((reply) => ({ id: reply.id, author: reply.author, date: reply.date.toISOString().replace('.000', ''), body: reply.body })),
      relatedTopicId: topic.relatedTopicId,
      viewpoint: topic.viewpoint,
    })
  })

  it('declares in extensions.xml every type and status a topic uses', () => {
    const extensions = parse(files.get('extensions.xml')).documentElement
    const values = (group: string, tag: string) => children(child(extensions, group) as Element, tag).map((node) => node.textContent)
    expect(values('TopicTypes', 'TopicType')).toEqual(['Hint', 'Question', 'Defect'])
    expect(values('TopicStatuses', 'TopicStatus')).toEqual(['Open', 'Resolved', 'Dismissed'])
    expect(values('Users', 'User')).toContain('max@example.at')
    expect(parse(files.get('bcf.version')).documentElement.getAttribute('VersionId')).toBe('3.0')
  })
})
