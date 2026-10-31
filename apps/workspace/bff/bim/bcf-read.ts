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
 * that is a real PNG or JPEG of at most 1.5 MB, judged on its declared size
 * before it is inflated. A camera whose aspect ratio or field of view lies
 * outside what F1 stores is clamped into it and the thread says so.
 *
 * ## Dates and booleans as XML Schema writes them
 *
 * An `xs:dateTime` without an offset is read as UTC, never in the server's own
 * zone; `xs:boolean` is `true`, `false`, `1` or `0`.
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
import type { BcfArchive } from './bcf-archive'
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
  /** The camera's aspect ratio or field of view was clamped into the stored range. */
  camera: boolean
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
function versionOf(files: BcfArchive): string | null {
  const entry = files.read('bcf.version')
  if (!entry) return null
  try {
    return parseBcfXml(textOf(entry)).attributes.VersionId?.trim() || null
  } catch {
    return null
  }
}

/** An offset (`Z`, `+01:00`) at the end of an `xs:dateTime`. */
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i

/** An `xs:dateTime` as an instant, one without an offset read as UTC; null for one that does not parse. */
export const instant = (value: string | null): Date | null => {
  const trimmed = value?.trim()
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return null
  const parsed = new Date(HAS_OFFSET.test(trimmed) ? trimmed : `${trimmed}Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** An `xs:boolean` (`true`, `false`, `1`, `0`), or `fallback` when absent or none of those. */
export function xsBoolean(value: string | undefined, fallback: boolean): boolean {
  const trimmed = value?.trim()
  if (trimmed === 'true' || trimmed === '1') return true
  if (trimmed === 'false' || trimmed === '0') return false
  return fallback
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const finite = (value: string | null): number | null => {
  if (value === null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function vec(element: XmlElement | null): Vec3 | null {
  const [x, y, z] = ['X', 'Y', 'Z'].map((axis) => finite(childText(element, axis)))
  return x === null || y === null || z === null ? null : { x, y, z }
}

/** The ranges `cameraSchema` holds (F1): a writer's 0.05 or 180 is clamped, not a reason to drop the view. */
const ASPECT_RANGE = [0.1, 10] as const
const FIELD_OF_VIEW_RANGE = [1, 179] as const

/** The camera, clamped into F1's ranges (and whether that was needed), or null for none or one with no direction. */
function cameraOf(info: XmlElement): { camera: ViewpointCamera; clamped: boolean } | null {
  const perspective = childNamed(info, 'PerspectiveCamera')
  const orthogonal = childNamed(info, 'OrthogonalCamera')
  const element = perspective ?? orthogonal
  if (!element) return null
  const aspect = finite(childText(element, 'AspectRatio'))
  const fieldOfView = finite(childText(element, 'FieldOfView'))
  const aspectRatio = aspect === null || aspect <= 0 ? DEFAULT_ASPECT_RATIO : clamp(aspect, ...ASPECT_RANGE)
  const field = fieldOfView === null || fieldOfView <= 0 ? null : clamp(fieldOfView, ...FIELD_OF_VIEW_RANGE)
  const shared = {
    position: vec(childNamed(element, 'CameraViewPoint')),
    direction: vec(childNamed(element, 'CameraDirection')),
    up: vec(childNamed(element, 'CameraUpVector')),
    aspectRatio,
  }
  const candidate = perspective
    ? { type: 'perspective', ...shared, fieldOfView: field }
    : { type: 'orthographic', ...shared, viewToWorldScale: finite(childText(element, 'ViewToWorldScale')) }
  const parsed = cameraSchema.safeParse(candidate)
  if (!parsed.success) return null
  const clamped = (aspect !== null && aspect > 0 && aspect !== aspectRatio) || (perspective !== null && fieldOfView !== null && field !== fieldOfView)
  return { camera: parsed.data, clamped }
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
  const defaultVisibility = visibilityElement ? xsBoolean(visibilityElement.attributes.DefaultVisibility, false) : true
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
  files: BcfArchive,
  path: string | null
): { snapshot: BcfViewpointRead['snapshot']; cut: BcfViewCuts['snapshot'] } {
  if (!path) return { snapshot: null, cut: null }
  const declared = files.declaredSize(path)
  if (declared === null || declared === 0) return { snapshot: null, cut: 'missing' }
  // Judged on what it declares, before a byte is inflated; what inflates is held to that by the archive.
  if (declared > MAX_SNAPSHOT_BYTES) return { snapshot: null, cut: 'too_large' }
  const bytes = files.read(path) ?? new Uint8Array(0)
  const contentType: SnapshotContentType | null = startsWith(bytes, PNG) ? 'image/png' : startsWith(bytes, JPEG) ? 'image/jpeg' : null
  if (!contentType) return { snapshot: null, cut: 'not_an_image' }
  return { snapshot: { contentType, bytes }, cut: null }
}

/** A file named inside the topic's folder; a name with a slash would leave it, so it is no file of this topic. */
const inFolder = (folder: string, name: string | null): string | null =>
  name && !name.includes('/') && !name.includes('\\') ? `${folder}/${name}` : null

function readView(files: BcfArchive, bcfv: string, snapshotPath: string | null): BcfViewpointRead | null {
  const bytes = files.read(bcfv)
  if (!bytes) return null
  let info: XmlElement
  try {
    info = parseBcfXml(textOf(bytes))
  } catch (error) {
    if (error instanceof BcfXmlError) return null
    throw error
  }
  const read = cameraOf(info)
  if (!read) return null
  const { planes, dropped } = planesOf(info)
  const { components, selectionCut, visibilityCut } = componentsOf(info)
  const { snapshot, cut } = snapshotOf(files, snapshotPath)
  return {
    viewpoint: { camera: read.camera, clippingPlanes: planes, components },
    snapshot,
    cuts: { planes: dropped, selection: selectionCut, visibility: visibilityCut, snapshot: cut, camera: read.clamped },
  }
}

/** The topic's views in the order written: 3.0's `Topic/Viewpoints/ViewPoint`, 2.1's `Markup/Viewpoints`, else 2.0's fixed names. */
function viewRefs(files: BcfArchive, markup: XmlElement, topic: XmlElement, folder: string): { bcfv: string; snapshot: string | null }[] {
  const listed = [...childrenNamed(childNamed(topic, 'Viewpoints'), 'ViewPoint'), ...childrenNamed(markup, 'Viewpoints')]
  const refs = listed.flatMap((entry) => {
    const bcfv = inFolder(folder, childText(entry, 'Viewpoint'))
    return bcfv ? [{ bcfv, snapshot: inFolder(folder, childText(entry, 'Snapshot')) }] : []
  })
  if (refs.length > 0) return refs
  const legacySnapshot = `${folder}/snapshot.png`
  return [{ bcfv: `${folder}/viewpoint.bcfv`, snapshot: files.has(legacySnapshot) ? legacySnapshot : null }]
}

function commentsOf(markup: XmlElement, topic: XmlElement): BcfCommentRead[] {
  const elements = [...childrenNamed(childNamed(topic, 'Comments'), 'Comment'), ...childrenNamed(markup, 'Comment')]
  return elements.flatMap((comment) => {
    const text = childText(comment, 'Comment')
    return text ? [{ date: instant(childText(comment, 'Date')), author: childText(comment, 'Author'), text }] : []
  })
}

function readTopic(files: BcfArchive, folder: string, bytes: Uint8Array): BcfTopicRead | BcfTopicUnread {
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
  const view = viewRefs(files, markup, topic, folder).reduce<BcfViewpointRead | null>(
    (found, ref) => found ?? readView(files, ref.bcfv, ref.snapshot),
    null
  )
  return {
    folder,
    // Some writers wrap a GUID in braces, as Windows prints one.
    guid: topic.attributes.Guid?.trim().replace(/^\{(.*)\}$/, '$1').trim() || folder,
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

/**
 * Every topic folder of an opened BCF file, in archive order. Reads only what
 * a topic names: its markup, its views until one has a camera, and their
 * pictures; a member nothing names is never inflated.
 */
export function readBcf(files: BcfArchive): BcfRead {
  const topics: BcfTopicRead[] = []
  const unread: BcfTopicUnread[] = []
  for (const path of files.paths) {
    const match = /^([^/]+)\/markup\.bcf$/i.exec(path)
    if (!match) continue
    const entry = readTopic(files, match[1], files.read(path) ?? new Uint8Array(0))
    if (isRead(entry)) topics.push(entry)
    else unread.push(entry)
  }
  return { version: versionOf(files), topics, unread }
}

/** Whether the version is one this reader was written against: 2.0, 2.1 or 3.0, or unstated. */
export const isReadableVersion = (version: string | null): boolean => version === null || /^(2\.[01]|3\.0)$/.test(version)
