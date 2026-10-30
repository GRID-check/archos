/**
 * A model's Anmerkungen as a BCF 3.0 archive (`.bcf`): the ONE mapping from our
 * lifecycle to buildingSMART's BCF-XML 3.0 (release_3_0). Pure: the service
 * (`./bcf3-service.ts`) reads the records and hands them over; nothing here
 * touches a database, a clock or the network, so the same records are the same
 * bytes (with {@link createZip}), and the schemas can be run against the output.
 *
 * Sources: the 3.0 `markup.xsd`, `visinfo.xsd`, `extensions.xsd`, `version.xsd`
 * and the documentation's folder rules. Where this file says "the schema", that
 * is the one meant. The compliance export (`./bcf.ts`) is BCF 2.1 and stays the
 * default download; this is the second, newer file, not a replacement.
 *
 * ## The mapping
 *
 * | BCF 3.0 | Ours |
 * |---|---|
 * | `Topic/@Guid` | the Anmerkung's id, lowercase |
 * | `@ServerAssignedId` | its number („Anmerkung 4“) |
 * | `Title` | the first line of the body |
 * | `Description` | the whole body, then the basis and who set it, in the reader's language |
 * | `@TopicType` | kind: Hint, Question, Defect |
 * | `@TopicStatus` | status: Open, Resolved, Dismissed |
 * | `AssignedTo`, `DueDate` | the Zuständige's email, the Frist |
 * | `CreationAuthor/Date` | who set it, when |
 * | `Comments` | its replies |
 * | `Viewpoints` | its viewpoint, `.bcfv` and snapshot |
 * | `RelatedTopics` | the mark it was carried from |
 *
 * `extensions.xml` declares all three types and all three statuses, because the
 * schema says `TopicType` and `TopicStatus` take their values from it. A
 * Vorschlag (`proposed`) has no status here: it is not yet the office's record
 * and the service does not hand it over.
 *
 * Left out on purpose: `Priority`, `Stage` and `Labels` (we have none, and an
 * invented one reads as a decision), `Index` (deprecated in 3.0),
 * `DocumentReferences` (the model is named in `Header/Files`, and no document
 * travels in the archive), `BimSnippet`.
 */

import { createZip, type ZipEntry } from './zip'
import { isoDate, text } from './bcf'
import { bcf3ViewpointXml, type Bcf3ViewpointContent } from './bcf3-viewpoint'
import type { AnnotationKind, AnnotationStatus } from '@/lib/annotations/types'
import type { SnapshotContentType } from '@/lib/annotations/viewpoint-types'

/** TopicType values: our kinds, in the order the vocabulary lists them. */
export const BCF3_TOPIC_TYPES: Record<AnnotationKind, string> = {
  hint: 'Hint',
  question: 'Question',
  defect: 'Defect',
}

/** TopicStatus values. `proposed` is absent: it is never exported. */
export const BCF3_TOPIC_STATUSES: Record<Exclude<AnnotationStatus, 'proposed'>, string> = {
  open: 'Open',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
}

const SNAPSHOT_EXTENSION: Record<SnapshotContentType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' }

/** `IfcProject` and `IfcGuid` are exactly 22 characters of IFC's alphabet; anything else makes the markup invalid. */
const IFC_GLOBAL_ID = /^[0-9A-Za-z_$]{22}$/
/** `Guid` is lowercase; the documentation requires it of the folder name too. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const TITLE_CHARS = 200

export interface Bcf3Snapshot {
  contentType: SnapshotContentType
  bytes: Uint8Array
}

export interface Bcf3Reply {
  id: string
  /** Email when the directory has one, else the name. */
  author: string
  date: Date
  body: string
  /** Set when its author reworded it; the author is the one who did. */
  editedAt: Date | null
}

export interface Bcf3Topic {
  id: string
  number: number
  kind: AnnotationKind
  status: Exclude<AnnotationStatus, 'proposed'>
  body: string
  /**
   * Lines after the body in `Description`, already in the reader's language:
   * the basis, and that the agent set the mark and a person took it over (said
   * there, never hidden in the author). This file holds no copy of its own.
   */
  notes: readonly string[]
  /** The Zuständige's email, or their name when the directory has no email. */
  assignedTo: string | null
  /** A calendar day, `YYYY-MM-DD`. */
  dueOn: string | null
  createdBy: string
  createdAt: Date
  /** Who closed it and when: the only change of a mark whose author we record. */
  modified: { by: string; at: Date } | null
  replies: readonly Bcf3Reply[]
  viewpoint: (Bcf3ViewpointContent & { snapshot: Bcf3Snapshot | null }) | null
  /** The topic this one was carried from, when the reader may open it. */
  relatedTopicId: string | null
}

export interface Bcf3Input {
  model: {
    filename: string
    ifcProjectGlobalId: string | null
    /** Dates the file reference; from the data, never from a clock. */
    updatedAt: Date
  }
  topics: readonly Bcf3Topic[]
}

export interface Bcf3Export {
  bytes: Uint8Array
  topics: number
}

const XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'

const VERSION_XML = ['<?xml version="1.0" encoding="UTF-8"?>', `<Version VersionId="3.0" ${XSI} />`, ''].join('\n')

/** The first non-blank line of the body, cut at {@link TITLE_CHARS} (by code point, never mid-surrogate). */
export function bcf3Title(body: string): string {
  const first = body.split(/\r?\n/).find((line) => line.trim() !== '') ?? body
  const chars = Array.from(first.trim())
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join('')}…` : chars.join('')
}

function description(topic: Bcf3Topic, title: string): string | null {
  const parts: string[] = []
  const body = topic.body.trim()
  // A one-line body is the title already; repeating it under "Description" only fills the card.
  if (body !== title) parts.push(body)
  parts.push(...topic.notes.filter((note) => note.trim() !== ''))
  return parts.length > 0 ? parts.join('\n\n') : null
}

const dueDate = (dueOn: string): string => `${dueOn}T12:00:00Z`

function commentLines(reply: Bcf3Reply): string[] {
  return [
    `      <Comment Guid="${reply.id}">`,
    `        <Date>${isoDate(reply.date)}</Date>`,
    `        <Author>${text(reply.author)}</Author>`,
    `        <Comment>${text(reply.body)}</Comment>`,
    ...(reply.editedAt
      ? [`        <ModifiedDate>${isoDate(reply.editedAt)}</ModifiedDate>`, `        <ModifiedAuthor>${text(reply.author)}</ModifiedAuthor>`]
      : []),
    '      </Comment>',
  ]
}

function viewpointFiles(topic: Bcf3Topic): { bcfv: string; snapshot: string | null } | null {
  const viewpoint = topic.viewpoint
  if (!viewpoint) return null
  return {
    bcfv: `${viewpoint.id}.bcfv`,
    snapshot: viewpoint.snapshot ? `${viewpoint.id}.${SNAPSHOT_EXTENSION[viewpoint.snapshot.contentType]}` : null,
  }
}

/** The elements of `Topic`, in the order of the schema's sequence. */
function topicLines(topic: Bcf3Topic): string[] {
  const title = bcf3Title(topic.body)
  const described = description(topic, title)
  const files = viewpointFiles(topic)
  const lines = [
    `  <Topic Guid="${topic.id}" ServerAssignedId="${topic.number}" TopicType="${BCF3_TOPIC_TYPES[topic.kind]}" TopicStatus="${BCF3_TOPIC_STATUSES[topic.status]}">`,
    `    <Title>${text(title)}</Title>`,
    `    <CreationDate>${isoDate(topic.createdAt)}</CreationDate>`,
    `    <CreationAuthor>${text(topic.createdBy)}</CreationAuthor>`,
  ]
  if (topic.modified) {
    lines.push(
      `    <ModifiedDate>${isoDate(topic.modified.at)}</ModifiedDate>`,
      `    <ModifiedAuthor>${text(topic.modified.by)}</ModifiedAuthor>`
    )
  }
  if (topic.dueOn) lines.push(`    <DueDate>${dueDate(topic.dueOn)}</DueDate>`)
  if (topic.assignedTo) lines.push(`    <AssignedTo>${text(topic.assignedTo)}</AssignedTo>`)
  if (described) lines.push(`    <Description>${text(described)}</Description>`)
  if (topic.relatedTopicId) {
    lines.push('    <RelatedTopics>', `      <RelatedTopic Guid="${topic.relatedTopicId}" />`, '    </RelatedTopics>')
  }
  if (topic.replies.length > 0) {
    lines.push('    <Comments>', ...topic.replies.flatMap(commentLines), '    </Comments>')
  }
  if (topic.viewpoint && files) {
    lines.push(
      '    <Viewpoints>',
      `      <ViewPoint Guid="${topic.viewpoint.id}">`,
      `        <Viewpoint>${files.bcfv}</Viewpoint>`,
      ...(files.snapshot ? [`        <Snapshot>${files.snapshot}</Snapshot>`] : []),
      '      </ViewPoint>',
      '    </Viewpoints>'
    )
  }
  lines.push('  </Topic>')
  return lines
}

function markupXml(topic: Bcf3Topic, model: Bcf3Input['model']): string {
  const project = model.ifcProjectGlobalId && IFC_GLOBAL_ID.test(model.ifcProjectGlobalId) ? ` IfcProject="${model.ifcProjectGlobalId}"` : ''
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Markup ${XSI}>`,
    '  <Header>',
    '    <Files>',
    `      <File${project} IsExternal="true">`,
    `        <Filename>${text(model.filename)}</Filename>`,
    `        <Date>${isoDate(model.updatedAt)}</Date>`,
    '      </File>',
    '    </Files>',
    '  </Header>',
    ...topicLines(topic),
    '</Markup>',
    '',
  ].join('\n')
}

function extensionsXml(topics: readonly Bcf3Topic[]): string {
  const users = [
    ...new Set(topics.flatMap((topic) => [topic.createdBy, ...(topic.assignedTo ? [topic.assignedTo] : []), ...topic.replies.map((reply) => reply.author)])),
  ].sort()
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Extensions ${XSI}>`,
    '  <TopicTypes>',
    ...Object.values(BCF3_TOPIC_TYPES).map((type) => `    <TopicType>${type}</TopicType>`),
    '  </TopicTypes>',
    '  <TopicStatuses>',
    ...Object.values(BCF3_TOPIC_STATUSES).map((status) => `    <TopicStatus>${status}</TopicStatus>`),
    '  </TopicStatuses>',
    ...(users.length > 0 ? ['  <Users>', ...users.map((user) => `    <User>${text(user)}</User>`), '  </Users>'] : []),
    '</Extensions>',
    '',
  ].join('\n')
}

function topicEntries(topic: Bcf3Topic, model: Bcf3Input['model']): ZipEntry[] {
  const folder = topic.id
  const entries: ZipEntry[] = [
    // The topic FOLDER as its own entry, as `bcf.ts` does (see `DOS_DIRECTORY` in `zip.ts`).
    { path: `${folder}/`, content: '' },
    { path: `${folder}/markup.bcf`, content: markupXml(topic, model) },
  ]
  const files = viewpointFiles(topic)
  if (topic.viewpoint && files) {
    entries.push({ path: `${folder}/${files.bcfv}`, content: bcf3ViewpointXml(topic.viewpoint) })
    if (topic.viewpoint.snapshot && files.snapshot) {
      entries.push({ path: `${folder}/${files.snapshot}`, content: topic.viewpoint.snapshot.bytes })
    }
  }
  return entries
}

/** Every id that becomes a `Guid` or a folder name is lowercase and a UUID, or the archive is refused. */
function assertGuids(topics: readonly Bcf3Topic[]): void {
  const ids = topics.flatMap((topic) => [
    topic.id,
    ...topic.replies.map((reply) => reply.id),
    ...(topic.viewpoint ? [topic.viewpoint.id] : []),
    ...(topic.relatedTopicId ? [topic.relatedTopicId] : []),
  ])
  const bad = ids.find((id) => !GUID.test(id))
  if (bad !== undefined) throw new Error(`Not a lowercase UUID, so not a BCF Guid: ${JSON.stringify(bad)}`)
}

/**
 * Build the archive: `bcf.version`, `extensions.xml`, then one folder per topic
 * in the order given. No topics is a valid archive.
 */
export function buildAnnotationsBcf3(input: Bcf3Input): Bcf3Export {
  assertGuids(input.topics)
  const entries: ZipEntry[] = [
    { path: 'bcf.version', content: VERSION_XML },
    { path: 'extensions.xml', content: extensionsXml(input.topics) },
    ...input.topics.flatMap((topic) => topicEntries(topic, input.model)),
  ]
  return { bytes: createZip(entries), topics: input.topics.length }
}
