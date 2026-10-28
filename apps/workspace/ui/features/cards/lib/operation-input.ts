/**
 * The input of a proposed operation, flattened into rows a person can read on
 * the card (`OperationReceipt`): one row per path parameter, query parameter
 * and top-level body field, in that order of importance reversed so what the
 * action changes (the body) comes first.
 *
 * Nothing is left out and nothing is cut for good. Every row carries its whole
 * value: a scalar as it is, anything nested as indented JSON. A value longer
 * than {@link PREVIEW_LENGTH}, or one spread over several lines, is `long`: the
 * card shows its {@link previewOf} until the reader unfolds it, and „Apply“
 * waits until every long row has been unfolded, so a person never accepts text
 * they were not shown (an injected instruction at the end of a long body).
 *
 * A value that is an id the server named for this reader (the proposal's
 * `targets`: a project, a document, a folder, a person) reads as that name; the
 * id stays on the row (`ids`) for whoever checks it. An id nobody named stays
 * the id.
 */

export interface OperationInputRow {
  key: string
  /** The whole value, as the card shows it unfolded. */
  value: string
  /** Shown in part until the reader unfolds it; the card refuses „Apply“ until then. */
  long: boolean
  /** Where the field sits in the call: a path parameter is the object the action acts on. */
  source: 'body' | 'query' | 'params'
  /** The value as the call carries it, when {@link value} shows names in place of its ids. */
  ids?: string
}

/** The name the reader knows an id by, or null to show the id. */
export type IdName = (id: string) => string | null | undefined

/** Longest value shown whole without unfolding. */
export const PREVIEW_LENGTH = 160

function show(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A string, or a list of strings, with every id the reader knows by name replaced by it; anything else as it is. */
function named(value: unknown, nameOf: IdName): unknown {
  if (typeof value === 'string') return nameOf(value) ?? value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.map((item) => nameOf(item) ?? item)
  return value
}

function rowOf(key: string, value: unknown, source: OperationInputRow['source'], nameOf: IdName): OperationInputRow {
  const raw = show(value)
  const text = show(named(value, nameOf))
  const row: OperationInputRow = { key, value: text, long: text.length > PREVIEW_LENGTH || text.includes('\n'), source }
  return text === raw ? row : { ...row, ids: raw }
}

function rowsOf(record: unknown, source: OperationInputRow['source'], nameOf: IdName): OperationInputRow[] {
  if (!isRecord(record)) return []
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => rowOf(key, value, source, nameOf))
}

const unnamed: IdName = () => null

/** Every row of `input`, body first, then query, then path parameters; ids `nameOf` knows read as names. */
export function operationInputRows(input: Record<string, unknown>, nameOf: IdName = unnamed): OperationInputRow[] {
  const body = input.body
  const bodyRows = isRecord(body)
    ? rowsOf(body, 'body', nameOf)
    : body === undefined || body === null
      ? []
      : [rowOf('body', body, 'body', nameOf)]
  return [...bodyRows, ...rowsOf(input.query, 'query', nameOf), ...rowsOf(input.params, 'params', nameOf)]
}

/** The start of a long value, on one line, marked as cut. */
export function previewOf(row: OperationInputRow): string {
  const flat = row.value.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : `${flat}…`
}

/**
 * The input fields most actions take, named in the person's language
 * (`cards.operationProposal.inputKeys`): the fields of the catalog's writes by
 * how often they occur (October 2026), and the proposal card's own. Any other
 * field reads as its name in words (`humanizeKey`, English), so a field that
 * shows up often on a German card belongs here.
 */
export const NAMED_INPUT_KEYS = [
  'id',
  'name',
  'title',
  'description',
  'scope',
  'memoryScope',
  'projectId',
  'folderId',
  'parentId',
  'documentId',
  'conversationId',
  'messageId',
  'versionId',
  'annotationId',
  'taskId',
  'itemId',
  'skillId',
  'categoryId',
  'resourceType',
  'resourceId',
  'targetFolder',
  'body',
  'note',
  'comment',
  'content',
  'message',
  'question',
  'reason',
  'decision',
  'kind',
  'role',
  'status',
  'enabled',
  'pinned',
  'confidence',
  'locale',
  'fileName',
  'files',
  'names',
  'displayName',
  'email',
  'visibility',
  'permissions',
  'sortOrder',
] as const

export type NamedInputKey = (typeof NAMED_INPUT_KEYS)[number]

export const isNamedInputKey = (key: string): key is NamedInputKey => (NAMED_INPUT_KEYS as readonly string[]).includes(key)

/** A field name in words: `folderId` → "Folder ID", `target_folder` → "Target folder", `if-match` → "If match". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => (/^id$/i.test(word) ? 'ID' : word.toLowerCase()))
  if (words.length === 0) return key
  const [first, ...rest] = words
  return [first === 'ID' ? first : first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ')
}

/** A stable key per row: the same field name may occur in body, query and params. */
export const rowKey = (row: OperationInputRow, index: number) => `${index}:${row.key}`
