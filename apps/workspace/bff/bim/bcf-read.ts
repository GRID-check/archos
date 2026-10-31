/**
 * What a BCF file says, read from its unpacked members (`./bcf-archive.ts`):
 * BCF-XML 2.1 and 3.0, the same reader for both. Pure: no `server-only`, no
 * I/O, no knowledge of our records; the mapping onto an Anmerkung is
 * `./bcf-import-map.ts`.
 *
 * ## Where 2.1 and 3.0 differ, and how both are read
 *
 * | | 2.1 | 3.0 |
 * |---|---|---|
 * | Comments | `Markup/Comment`, beside the topic | `Markup/Topic/Comments/Comment` |
 * | Viewpoints | `Markup/Viewpoints` (one per view) | `Markup/Topic/Viewpoints/ViewPoint` |
 * | Coloring | `Color/Component` | `Color/Components/Component` |
 * | AspectRatio | absent: {@link DEFAULT_ASPECT_RATIO} | on the camera |
 *
 * Both places are read in either version, so a writer that mixes them still
 * reads. A 2.0-era folder with no `Viewpoints` but a `viewpoint.bcfv` (and
 * `snapshot.png`) uses those.
 *
 * ## What a topic keeps of its view
 *
 * The FIRST viewpoint: the one a BCF manager opens with the topic. A viewpoint
 * with no camera is no view (BCF allows a components-only one); such a topic is
 * reported as having none. Elements are named by `IfcGuid`; a component with
 * only an `AuthoringToolId` is dropped and counted. Everything is bounded to
 * F1's table (`../annotations/viewpoint-types.ts`): six section planes, 500
 * selected and coloured elements, 2000 visibility exceptions (past it the view
 * shows the whole model, as the viewer's own capture does), and a snapshot
 * that is a real PNG or JPEG of at most 1.5 MB.
 */

import {
  cameraSchema,
  globalIdSchema,
  MAX_CLIPPING_PLANES,
  MAX_SNAPSHOT_BYTES,
  MAX_VIEWPOINT_COLORINGS,
  MAX_VIEWPOINT_SELECTION,
  MAX_VISIBILITY_EXCEPTIONS,
  type ClippingPlane,
  type ParsedViewpointInput,
  type SnapshotContentType,
  type Vec3,
  type ViewpointCamera,
} from '@/lib/annotations/viewpoint-types'
import { BcfXmlError, childNamed, childrenNamed, childText, descendantsNamed, parseBcfXml, type XmlElement } from './bcf-xml'

/** Width over height when a 2.1 camera does not say: the common screen. */
export const DEFAULT_ASPECT_RATIO = 16 / 9

export interface BcfCommentRead {
  date: Date | null
  author: string | null
  text: string
}

/** What was cut from a view to fit, counted, so the mark's thread can say it. */
export interface BcfViewCuts {
  /** Section planes past six, or with no usable direction. */
  planes: number
  /** Selected elements past 500, or not named by an IfcGuid. */
  selection: number
  /** The visibility exceptions were too many: the view shows the whole model instead. */
  visibility: boolean
  /** Why the picture did not come along, or null when it did or there was none. */
  snapshot: 'too_large' | 'not_an_image' | 'missing' | null
}

export interface BcfViewpointRead {
  viewpoint: Omit<ParsedViewpointInput, 'snapshot' | 'pin'>
  snapshot: { contentType: SnapshotContentType; bytes: Uint8Array } | null
  cuts: BcfViewCuts
}

export interface BcfTopicRead {
  /** The topic folder, which BCF names after the topic's Guid. */
  folder: string
  /** `Topic/@Guid` as written, else the folder name. */
  guid: string
  title: string | null
  description: string | null
  topicType: string | null
  topicStatus: string | null
  assignedTo: string | null
  /** `DueDate` as written (`xs:dateTime`). */
  dueDate: string | null
  creationAuthor: string | null
  creationDate: Date | null
  comments: BcfCommentRead[]
  /** The first viewpoint with a camera, or null: none, none readable, or none with a camera. */
  view: BcfViewpointRead | null
}

export interface BcfTopicUnread {
  folder: string
  reason: 'bad_xml' | 'no_topic'
}

export interface BcfRead {
  /** `bcf.version`'s `VersionId`, or null when the file has none. */
  version: string | null
  topics: BcfTopicRead[]
  unread: BcfTopicUnread[]
}

const decoder = new TextDecoder('utf-8', { fatal: false })

const textOf = (bytes: Uint8Array): string => decoder.decode(bytes).replace(/^﻿/, '')

/** The `VersionId` of `bcf.version`, or null when the file is absent or unreadable. */
function versionOf(files: ReadonlyMap<string, Uint8Array>): string | null {
  const entry = files.get('bcf.version')
  if (!entry) return null
  try {
    return parseBcfXml(textOf(entry)).attributes.VersionId?.trim() || null
  } catch {
    return null
  }
}

/** An `xs:dateTime` as an instant, or null for one that does not parse. */
const instant = (value: string | null): Date | null => {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const finite = (value: string | null): number | null => {
  if (value === null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function vec(element: XmlElement | null): Vec3 | null {
  const [x, y, z] = ['X', 'Y', 'Z'].map((axis) => finite(childText(element, axis)))
  return x === null || y === null || z === null ? null : { x, y, z }
}

function cameraOf(info: XmlElement): ViewpointCamera | null {
  const perspective = childNamed(info, 'PerspectiveCamera')
  const orthogonal = childNamed(info, 'OrthogonalCamera')
  const element = perspective ?? orthogonal
  if (!element) return null
  const shared = {
    position: vec(childNamed(element, 'CameraViewPoint')),
    direction: vec(childNamed(element, 'CameraDirection')),
    up: vec(childNamed(element, 'CameraUpVector')),
    aspectRatio: finite(childText(element, 'AspectRatio')) ?? DEFAULT_ASPECT_RATIO,
  }
  const candidate = perspective
    ? { type: 'perspective', ...shared, fieldOfView: finite(childText(element, 'FieldOfView')) }
    : { type: 'orthographic', ...shared, viewToWorldScale: finite(childText(element, 'ViewToWorldScale')) }
  const parsed = cameraSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

const isGlobalId = (value: string): boolean => globalIdSchema.safeParse(value).success

/** The IfcGuids of these components, each once, and how many named none usable. */
function globalIdsOf(components: readonly XmlElement[]): { ids: string[]; dropped: number } {
  const ids = new Set<string>()
  let dropped = 0
  for (const component of components) {
    const id = component.attributes.IfcGuid?.trim() ?? ''
    if (isGlobalId(id)) ids.add(id)
    else dropped += 1
  }
  return { ids: [...ids], dropped }
}

function planesOf(info: XmlElement): { planes: ClippingPlane[]; dropped: number } {
  const planes: ClippingPlane[] = []
  let dropped = 0
  for (const plane of childrenNamed(childNamed(info, 'ClippingPlanes'), 'ClippingPlane')) {
    const location = vec(childNamed(plane, 'Location'))
    const direction = vec(childNamed(plane, 'Direction'))
    const usable = location && direction && Math.hypot(direction.x, direction.y, direction.z) > 0
    if (usable && planes.length < MAX_CLIPPING_PLANES) planes.push({ location, direction })
    else dropped += 1
  }
  return { planes, dropped }
}

const COLOR = /^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/

function componentsOf(info: XmlElement) {
  const components = childNamed(info, 'Components')
  const selected = globalIdsOf(childrenNamed(childNamed(components, 'Selection'), 'Component'))
  const visibilityElement = childNamed(components, 'Visibility')
  const exceptions = globalIdsOf(descendantsNamed(childNamed(visibilityElement, 'Exceptions'), 'Component')).ids
  // No Visibility element: nothing was hidden. With one, the schema's default for the attribute is false.
  const defaultVisibility = visibilityElement ? visibilityElement.attributes.DefaultVisibility?.trim() === 'true' : true
  const visibilityCut = exceptions.length > MAX_VISIBILITY_EXCEPTIONS
  const coloring = childrenNamed(childNamed(components, 'Coloring'), 'Color')
    .map((color) => ({
      color: color.attributes.Color?.trim() ?? '',
      globalIds: globalIdsOf(descendantsNamed(color, 'Component')).ids.slice(0, MAX_VIEWPOINT_SELECTION),
    }))
    .filter((entry) => COLOR.test(entry.color) && entry.globalIds.length > 0)
    .slice(0, MAX_VIEWPOINT_COLORINGS)
  return {
    components: {
      selection: { globalIds: selected.ids.slice(0, MAX_VIEWPOINT_SELECTION) },
      visibility: visibilityCut ? { defaultVisibility: true, exceptions: [] } : { defaultVisibility, exceptions },
      coloring,
    },
    selectionCut: selected.dropped + Math.max(0, selected.ids.length - MAX_VIEWPOINT_SELECTION),
    visibilityCut,
  }
}

const PNG = [0x89, 0x50, 0x4e, 0x47]
const JPEG = [0xff, 0xd8, 0xff]
const startsWith = (bytes: Uint8Array, magic: readonly number[]) => magic.every((byte, index) => bytes[index] === byte)

/** The picture a viewpoint names, judged by its bytes, never its extension. */
function snapshotOf(
  files: ReadonlyMap<string, Uint8Array>,
  path: string | null
): { snapshot: BcfViewpointRead['snapshot']; cut: BcfViewCuts['snapshot'] } {
  if (!path) return { snapshot: null, cut: null }
  const bytes = files.get(path)
  if (!bytes || bytes.length === 0) return { snapshot: null, cut: 'missing' }
  const contentType: SnapshotContentType | null = startsWith(bytes, PNG) ? 'image/png' : startsWith(bytes, JPEG) ? 'image/jpeg' : null
  if (!contentType) return { snapshot: null, cut: 'not_an_image' }
  if (bytes.length > MAX_SNAPSHOT_BYTES) return { snapshot: null, cut: 'too_large' }
  return { snapshot: { contentType, bytes }, cut: null }
}

/** A file named inside the topic's folder; a name with a slash would leave it, so it is no file of this topic. */
const inFolder = (folder: string, name: string | null): string | null =>
  name && !name.includes('/') && !name.includes('\\') ? `${folder}/${name}` : null

function readView(files: ReadonlyMap<string, Uint8Array>, folder: string, bcfv: string, snapshotPath: string | null): BcfViewpointRead | null {
  const bytes = files.get(bcfv)
  if (!bytes) return null
  let info: XmlElement
  try {
    info = parseBcfXml(textOf(bytes))
  } catch (error) {
    if (error instanceof BcfXmlError) return null
    throw error
  }
  const camera = cameraOf(info)
  if (!camera) return null
  const { planes, dropped } = planesOf(info)
  const { components, selectionCut, visibilityCut } = componentsOf(info)
  const { snapshot, cut } = snapshotOf(files, snapshotPath)
  return {
    viewpoint: { camera, clippingPlanes: planes, components },
    snapshot,
    cuts: { planes: dropped, selection: selectionCut, visibility: visibilityCut, snapshot: cut },
  }
}

/** The topic's views in the order written: 3.0's `Topic/Viewpoints/ViewPoint`, 2.1's `Markup/Viewpoints`, else 2.0's fixed names. */
function viewRefs(markup: XmlElement, topic: XmlElement, folder: string): { bcfv: string; snapshot: string | null }[] {
  const listed = [...childrenNamed(childNamed(topic, 'Viewpoints'), 'ViewPoint'), ...childrenNamed(markup, 'Viewpoints')]
  const refs = listed.flatMap((entry) => {
    const bcfv = inFolder(folder, childText(entry, 'Viewpoint'))
    return bcfv ? [{ bcfv, snapshot: inFolder(folder, childText(entry, 'Snapshot')) }] : []
  })
  return refs.length > 0 ? refs : [{ bcfv: `${folder}/viewpoint.bcfv`, snapshot: `${folder}/snapshot.png` }]
}

function commentsOf(markup: XmlElement, topic: XmlElement): BcfCommentRead[] {
  const elements = [...childrenNamed(childNamed(topic, 'Comments'), 'Comment'), ...childrenNamed(markup, 'Comment')]
  return elements.flatMap((comment) => {
    const text = childText(comment, 'Comment')
    return text ? [{ date: instant(childText(comment, 'Date')), author: childText(comment, 'Author'), text }] : []
  })
}

function readTopic(files: ReadonlyMap<string, Uint8Array>, folder: string, bytes: Uint8Array): BcfTopicRead | BcfTopicUnread {
  let markup: XmlElement
  try {
    markup = parseBcfXml(textOf(bytes))
  } catch (error) {
    if (error instanceof BcfXmlError) return { folder, reason: 'bad_xml' }
    throw error
  }
  const topic = childNamed(markup, 'Topic')
  if (!topic) return { folder, reason: 'no_topic' }
  // The first view with a camera: a components-only one is no view to stand in.
  const view = viewRefs(markup, topic, folder).reduce<BcfViewpointRead | null>(
    (found, ref) => found ?? readView(files, folder, ref.bcfv, ref.snapshot),
    null
  )
  return {
    folder,
    guid: topic.attributes.Guid?.trim() || folder,
    title: childText(topic, 'Title'),
    description: childText(topic, 'Description'),
    topicType: topic.attributes.TopicType?.trim() || null,
    topicStatus: topic.attributes.TopicStatus?.trim() || null,
    assignedTo: childText(topic, 'AssignedTo'),
    dueDate: childText(topic, 'DueDate'),
    creationAuthor: childText(topic, 'CreationAuthor'),
    creationDate: instant(childText(topic, 'CreationDate')),
    comments: commentsOf(markup, topic),
    view,
  }
}

const isRead = (entry: BcfTopicRead | BcfTopicUnread): entry is BcfTopicRead => 'guid' in entry

/** Every topic folder of an unpacked BCF file, in archive order. */
export function readBcf(files: ReadonlyMap<string, Uint8Array>): BcfRead {
  const topics: BcfTopicRead[] = []
  const unread: BcfTopicUnread[] = []
  for (const [path, bytes] of files) {
    const match = /^([^/]+)\/markup\.bcf$/i.exec(path)
    if (!match) continue
    const entry = readTopic(files, match[1], bytes)
    if (isRead(entry)) topics.push(entry)
    else unread.push(entry)
  }
  return { version: versionOf(files), topics, unread }
}

/** Whether the version is one this reader was written against: 2.0, 2.1 or 3.0, or unstated. */
export const isReadableVersion = (version: string | null): boolean => version === null || /^(2\.[01]|3\.0)$/.test(version)
