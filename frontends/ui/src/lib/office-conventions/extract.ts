/**
 * The office's conventions, counted from its own projects (ADR-0129): which
 * folders its projects keep, where each Dokumentart is usually filed, the shape
 * of its Plannummern, its Index style and how its file names write a date.
 *
 * Pure and deterministic: the same rows give the same conventions, and every
 * line is a count a person could redo. No model, no I/O; `./service` reads the
 * rows and decides which may count (screened documents, folders not under an
 * own access list). Everything handed in here counts.
 *
 * A convention is a pattern, not an instance: a line is kept only when at
 * least {@link MIN_PROJECTS} projects show it and they are at least
 * {@link MIN_SHARE} of the projects that could. That threshold is also the
 * privacy floor: a name or a shape only one project carries is never stated,
 * and a Plannummer is stated as a shape, never as an example.
 */

import { folderMatchKey } from '@/lib/projects/folders'

/** The shape of the stored JSON; bump when a field changes meaning, and the stored row is recomputed. */
export const EXTRACTOR_VERSION = 2

/** A convention needs at least this many projects behind it. */
export const MIN_PROJECTS = 3

/** ...and at least this share of the projects that could show it. */
export const MIN_SHARE = 0.5

/** Most folder-skeleton entries kept. */
export const MAX_SKELETON_FOLDERS = 12

/** Folder depth the skeleton is learned to (`Behörde/Gutachten` is depth 2). */
export const MAX_SKELETON_DEPTH = 2

/** One document as the extractor reads it. */
export interface ConventionDocument {
  projectId: string
  /** The folder path it is filed under, as the shelf shows it; `''` at the root. */
  folderPath: string
  filename: string
  /** The Dokumentart (a controlled document-type tag), or null when none or `Sonstiges`. */
  docType: string | null
  /** The title block's Plannummer, when one was read. */
  documentNumber: string | null
  /** The title block's Index, when one was read. */
  revision: string | null
  /** When it was uploaded; reads a six-digit date in its name (`260315` is 2026, not 2015). */
  uploadedAt?: Date | null
}

/** One living folder of a project, as the extractor reads it. */
export interface ConventionFolder {
  projectId: string
  path: string
}

/** How many projects show a convention, of how many could. */
export interface Support {
  projects: number
  of: number
}

export type RevisionStyle = 'letter' | 'number' | 'padded_number' | 'letter_number'

export interface OfficeConventions {
  version: typeof EXTRACTOR_VERSION
  /** Projects the counts were taken over. */
  projects: number
  /** Folder paths most projects keep, most widely kept first. */
  folders: Array<{ path: string } & Support>
  /** Per Dokumentart, the folder it is usually filed in. */
  filing: Array<{ docType: string; path: string } & Support>
  /** The usual Plannummer shape (letters `A`, digits `0`, separators kept). */
  documentNumber: ({ shape: string } & Support) | null
  revisionStyle: ({ style: RevisionStyle } & Support) | null
  /** The usual date format in file names, e.g. `YYYYMMDD`. */
  fileDate: ({ format: string } & Support) | null
}

/** A leading ordinal an office numbers its folders with: `03_`, `3 - `, `03.`. */
const ORDINAL_PREFIX = /^\d{1,3}\s*[._-]?\s+|^\d{1,3}[._-]\s*/

/** A folder path compared without case, Unicode form or leading ordinals, segment by segment. */
export function conventionPathKey(path: string): string {
  return path
    .split('/')
    .map((segment) => folderMatchKey(segment.trim().replace(ORDINAL_PREFIX, '')))
    .filter((segment) => segment.length > 0)
    .join('/')
}

/** The most frequent value of a list, ties broken by the value itself; null for an empty list. */
function modal(values: readonly string[]): string | null {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && value < best)) {
      best = value
      bestCount = count
    }
  }
  return best
}

/** Group values per project. */
function perProject<T>(items: readonly T[], projectOf: (item: T) => string, valueOf: (item: T) => string | null) {
  const grouped = new Map<string, string[]>()
  for (const item of items) {
    const value = valueOf(item)
    if (value === null) continue
    const list = grouped.get(projectOf(item)) ?? []
    list.push(value)
    grouped.set(projectOf(item), list)
  }
  return grouped
}

/** Whether a count clears the pattern threshold. */
export function isPattern(support: Support): boolean {
  return support.of > 0 && support.projects >= MIN_PROJECTS && support.projects / support.of >= MIN_SHARE
}

/**
 * The value most projects agree on, as each project's own modal value:
 * one project with many documents counts once, as it should for a habit of
 * the office. Null when no value clears {@link isPattern}.
 */
function agreedAcrossProjects(grouped: ReadonlyMap<string, string[]>): ({ value: string } & Support) | null {
  const modes = [...grouped.values()].map(modal).filter((value): value is string => value !== null)
  const value = modal(modes)
  if (value === null) return null
  const support = { projects: modes.filter((mode) => mode === value).length, of: modes.length }
  return isPattern(support) ? { value, ...support } : null
}

/** The most common spelling seen for each key. */
function spellings(paths: Iterable<[key: string, spelling: string]>): Map<string, string> {
  const seen = new Map<string, string[]>()
  for (const [key, spelling] of paths) seen.set(key, [...(seen.get(key) ?? []), spelling])
  return new Map([...seen].map(([key, list]) => [key, modal(list) ?? key]))
}

/** A path cut to its first `depth` segments, with the cleaned spelling. */
function prefixes(path: string): string[] {
  const segments = path.split('/').map((segment) => segment.trim()).filter(Boolean)
  return segments.slice(0, MAX_SKELETON_DEPTH).map((_, index) => segments.slice(0, index + 1).join('/'))
}

function learnSkeleton(folders: readonly ConventionFolder[], projectsWithFolders: number) {
  const projectsByKey = new Map<string, Set<string>>()
  const seen: Array<[string, string]> = []
  for (const folder of folders) {
    for (const prefix of prefixes(folder.path)) {
      const key = conventionPathKey(prefix)
      if (!key) continue
      projectsByKey.set(key, (projectsByKey.get(key) ?? new Set()).add(folder.projectId))
      seen.push([key, prefix])
    }
  }
  const spelled = spellings(seen)
  return [...projectsByKey]
    .map(([key, projects]) => ({ path: spelled.get(key) ?? key, projects: projects.size, of: projectsWithFolders }))
    .filter(isPattern)
    .sort((a, b) => b.projects - a.projects || a.path.localeCompare(b.path))
    .slice(0, MAX_SKELETON_FOLDERS)
}

/**
 * The folder a document is filed in, cut to {@link MAX_SKELETON_DEPTH}: the
 * depth the skeleton shows the whole office. The conventions are the office's,
 * read by every member, including projects a member is not on (ADR-0129), so a
 * filing line names no folder deeper than the skeleton would.
 */
const filedIn = (doc: ConventionDocument): string => prefixes(doc.folderPath).at(-1) ?? ''

function learnFiling(documents: readonly ConventionDocument[]) {
  const filed = documents.filter((doc) => doc.docType !== null && conventionPathKey(filedIn(doc)) !== '')
  const spelled = spellings(filed.map((doc) => [conventionPathKey(filedIn(doc)), filedIn(doc)]))
  const types = [...new Set(filed.map((doc) => doc.docType as string))].sort()
  return types.flatMap((docType) => {
    const ofType = filed.filter((doc) => doc.docType === docType)
    const agreed = agreedAcrossProjects(perProject(ofType, (doc) => doc.projectId, (doc) => conventionPathKey(filedIn(doc))))
    if (!agreed) return []
    return [{ docType, path: spelled.get(agreed.value) ?? agreed.value, projects: agreed.projects, of: agreed.of }]
  })
}

/** A Plannummer as a shape: a run of letters is `A`, each digit `0`, everything else kept. */
export function documentNumberShape(value: string): string | null {
  const trimmed = value.trim().toUpperCase()
  if (trimmed.length < 3 || !/\d/.test(trimmed)) return null
  return trimmed.replace(/\p{L}+/gu, 'A').replace(/\d/g, '0').replace(/\s+/g, ' ')
}

/** The style of one Index value, or null when it is none of the four. */
export function revisionStyleOf(value: string): RevisionStyle | null {
  const bare = value.trim().replace(/^(index|idx|rev(ision)?)\.?\s*[:-]?\s*/i, '')
  if (/^\p{L}$/u.test(bare)) return 'letter'
  if (/^0\d$/.test(bare)) return 'padded_number'
  if (/^\d{1,3}$/.test(bare)) return 'number'
  if (/^\p{L}\d{1,2}$/u.test(bare)) return 'letter_number'
  return null
}

const validDay = (month: number, day: number): boolean => month >= 1 && month <= 12 && day >= 1 && day <= 31

/** How far before its upload a file name's date may lie, and how far after, to be read as one. */
const DATE_BEFORE_UPLOAD_MS = 3 * 365 * 24 * 3600 * 1000
const DATE_AFTER_UPLOAD_MS = 31 * 24 * 3600 * 1000

function nearUpload(year: number, month: number, day: number, uploadedAt: Date): boolean {
  if (!validDay(month, day)) return false
  const gap = uploadedAt.getTime() - Date.UTC(year, month - 1, day)
  return gap <= DATE_BEFORE_UPLOAD_MS && gap >= -DATE_AFTER_UPLOAD_MS
}

/**
 * Six digits are a date only when exactly one reading, `YYMMDD` or `DDMMYY`,
 * lands near the upload: most six-digit numbers are a drawing number, and
 * without an upload date the two readings cannot be told apart.
 */
function sixDigitFormat(name: string, uploadedAt: Date | null | undefined): string | null {
  const six = /(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/.exec(name)
  if (!six || !uploadedAt) return null
  const [first, month, last] = [Number(six[1]), Number(six[2]), Number(six[3])]
  const asYymmdd = nearUpload(2000 + first, month, last, uploadedAt)
  const asDdmmyy = nearUpload(2000 + last, month, first, uploadedAt)
  if (asYymmdd === asDdmmyy) return null
  return asYymmdd ? 'YYMMDD' : 'DDMMYY'
}

/**
 * The date format of the first date a file name writes, or null. A two-digit
 * year counts only with dots (`15.03.26`): `01-02-03` is far more often part of
 * a Plannummer than a date.
 */
export function fileDateFormatOf(filename: string, uploadedAt?: Date | null): string | null {
  const name = filename.replace(/\.[^.]+$/, '')
  const iso = /(?<!\d)(?:19|20)\d{2}([-_.])(\d{2})\1(\d{2})(?!\d)/.exec(name)
  if (iso && validDay(Number(iso[2]), Number(iso[3]))) return `YYYY${iso[1]}MM${iso[1]}DD`
  const european = /(?<!\d)(\d{2})([._-])(\d{2})\2((?:19|20)\d{2})(?!\d)|(?<!\d)(\d{2})\.(\d{2})\.(\d{2})(?!\d)/.exec(name)
  if (european) {
    const [day, month] = european[1] ? [european[1], european[3]] : [european[5], european[6]]
    const separator = european[2] ?? '.'
    if (validDay(Number(month), Number(day))) return `DD${separator}MM${separator}${european[4] ? 'YYYY' : 'YY'}`
  }
  const compact = /(?<!\d)(?:19|20)\d{2}(\d{2})(\d{2})(?!\d)/.exec(name)
  if (compact && validDay(Number(compact[1]), Number(compact[2]))) return 'YYYYMMDD'
  return sixDigitFormat(name, uploadedAt)
}

function learnPattern<T extends string>(
  documents: readonly ConventionDocument[],
  read: (doc: ConventionDocument) => T | null
): ({ value: T } & Support) | null {
  const agreed = agreedAcrossProjects(perProject(documents, (doc) => doc.projectId, read))
  return agreed as ({ value: T } & Support) | null
}

/** The office's conventions from its projects' open folders and screened documents. */
export function extractOfficeConventions(input: {
  documents: readonly ConventionDocument[]
  folders: readonly ConventionFolder[]
}): OfficeConventions {
  const { documents, folders } = input
  const projects = new Set([...documents.map((doc) => doc.projectId), ...folders.map((folder) => folder.projectId)])
  const projectsWithFolders = new Set(folders.map((folder) => folder.projectId)).size
  const number = learnPattern(documents, (doc) => (doc.documentNumber ? documentNumberShape(doc.documentNumber) : null))
  const revision = learnPattern(documents, (doc) => (doc.revision ? revisionStyleOf(doc.revision) : null))
  const date = learnPattern(documents, (doc) => fileDateFormatOf(doc.filename, doc.uploadedAt))
  return {
    version: EXTRACTOR_VERSION,
    projects: projects.size,
    folders: learnSkeleton(folders, projectsWithFolders),
    filing: learnFiling(documents),
    documentNumber: number && { shape: number.value, projects: number.projects, of: number.of },
    revisionStyle: revision && { style: revision.value, projects: revision.projects, of: revision.of },
    fileDate: date && { format: date.value, projects: date.projects, of: date.of },
  }
}
