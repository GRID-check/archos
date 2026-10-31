import 'server-only'
/**
 * The agent's read tools, offered to other agents over MCP (ADR-0122).
 *
 * `catalog/` covers what the BFF's routes do. Piloti's best READ tools live
 * only in the Python agent: knowledge search, passage reading, the file
 * browser, page images, the two BIM tools and RIS. An outside agent must get
 * them too, so each is an operation here, and the MCP server lists them beside
 * the catalog's. A call goes to the backend's `POST /v1/internal/tools/{name}`
 * (`apps/agent-host/src/agent_host/routes/internal_tools.py`).
 *
 * The input schema is the one the chat model reads, generated from the Python
 * functions into `tests/fixtures/backend-tools.schema.json`
 * (`scripts/generate_backend_tools_schema.py`, held current by
 * `packages/agent/tests/common/test_backend_tools_schema.py`). The DESCRIPTION is
 * this file's own, in English: the fixture's are Piloti's native tool
 * descriptions, written for Piloti's prompt in a German office, with German
 * terms, German example queries and Piloti's other tools (`surface_documents`,
 * cards) that an outside agent does not have. Anything an agent reads is
 * English, one word per concept (AGENTS.md, "Industry standard first"), so the
 * agent surface layers its own words over the fixture instead of changing
 * Piloti's tools, which the core-agent wave owns. The schema's property
 * descriptions keep the fixture's text with {@link ENGLISH_GLOSSES} applied.
 * `english-only.spec.ts` holds both to English. This file also says the MCP
 * name, the domain, and whether the tool needs a project.
 *
 * Who is asking is decided here, and signed. The backend cannot decide project
 * access (ADR-0003, ADR-0084), so {@link callBackendOperation} builds the
 * request context and collection scope for this person and project exactly as a
 * chat turn does (`resolveTurnContext`, which authorizes the project), signs
 * the envelope with the shared secret, and sends it with the internal token.
 * The BFF is the signer here, and the right one: it holds the session. The
 * backend verifies and forwards; it never signs.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { ApiError } from '@/lib/api/errors'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { requireProjectAccess } from '@/lib/authz/projects'
import { withTenant } from '@/lib/db/tenant-context'
import { getBackendUrl } from '@/lib/backend-url'
import { InternalServiceUnavailableError, internalServiceHeaders } from '@/lib/internal-auth'
import { resolveTurnContext, TurnBudgetExhaustedError } from '@/lib/turns/turn-context'
import { turnContextHeaders } from '@/lib/turns/turn-headers.js'
import backendTools from '../../tests/fixtures/backend-tools.schema.json'
import type { AgentDomain, ToolAnnotations } from './operation'
import { type OperationResult, readResponseBody } from './dispatch'
import { fittedHits, withOperationNames, withRankedOrderNote, type ToolNames } from './door-text'

export type { OperationResult }

/** A JSON Schema object, as the fixture carries it and the MCP `tools/list` shows it. */
export interface JsonSchemaObject {
  readonly type: 'object'
  readonly properties?: Record<string, unknown>
  readonly required?: readonly string[]
  readonly [keyword: string]: unknown
}

/** {@link ToolAnnotations}, except that a tool may reach beyond the workspace (the RIS lookup does). */
export type BackendAnnotations = Omit<ToolAnnotations, 'openWorldHint'> & { readonly openWorldHint: boolean }

export interface BackendOperation {
  /** `<entity>-<verb>`, kebab-case, unique across the catalog as well. */
  readonly name: string
  readonly domain: Extract<AgentDomain, 'knowledge' | 'bim'>
  /** One line for `tools` and `search`. */
  readonly summary: string
  /** What an outside agent reads: this file's English description, not the Python function's. */
  readonly description: string
  /** The Python function's name: the path segment of the backend route. */
  readonly tool: string
  /** The tool's input schema, with `projectId` added in front when the tool is project-scoped. */
  readonly inputSchema: JsonSchemaObject
  readonly annotations: BackendAnnotations
  /** The call is scoped to a project, which the person must be able to chat in. */
  readonly needsProject: boolean
  /**
   * With `shelf: "base"` the call reads the platform's shared corpus, which belongs to no project:
   * `projectId` may then be left out (the schema does not require it).
   */
  readonly projectOptionalForBase?: true
}

interface FixtureTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchemaObject
  readonly annotations: Omit<ToolAnnotations, 'title'>
}

/** What this file says about a tool the fixture describes. */
interface Entry {
  readonly name: string
  readonly tool: string
  readonly domain: BackendOperation['domain']
  readonly summary: string
  /** The English description an outside agent reads, written for this surface (see the module comment). */
  readonly description: string
  readonly needsProject: boolean
  /** See {@link BackendOperation.projectOptionalForBase}. */
  readonly projectOptionalForBase?: true
  /** The tool reaches a public service outside the workspace. */
  readonly openWorld?: boolean
}

const ENTRIES = [
  {
    name: 'knowledge-search',
    tool: 'knowledge_search',
    domain: 'knowledge',
    summary:
      'Search the project’s, the office’s and the building-law documents for quotable passages',
    description:
      'Search the stored documents for quotable passages: the shared OIB corpus (the Austrian building guidelines), ' +
      'the project’s documents and the office shelf. The evidence tool: each hit is an excerpt with a citation key to quote verbatim. ' +
      'Call it for any question that needs a passage from a stored document. Rewrite the question into a search query (topic, ' +
      'jurisdiction, year); the documents are mostly German, so query in the documents’ language. Narrow with `file_name` (an ' +
      'exact name from files-list), `doc_class` (a document type key such as `oib_guideline`), `title_contains` or `folder` (a ' +
      'folder path; it covers everything below it). `match: "exact"` finds every passage that contains the query literally, ' +
      'plus each matching file with its count and pages; use it for a number, a code, a name or to prove a term appears nowhere, ' +
      'with several spellings separated by `|`; `stemmed: true` also finds the inflected forms of each word (German stemming). ' +
      '`match: "regex"` is the same search with a pattern in Python syntax (case-insensitive, ' +
      '`|` is alternation; for example `MA 37/\\d{6}`); it needs one literal whole word or number it must contain (`MA ?37` has ' +
      'none), or a `folder`, `file_name` or `doc_class` to read in, and a pattern that backtracks is refused. A regex answer also ' +
      'lists every distinct matched string with its count, files and pages. `shelf` (`project`, `office` or `base`) reads one shelf ' +
      'only (`base` needs no `projectId`); omitted, every shelf is read, the OIB corpus included, so pass `project` for whether something is in the ' +
      'project’s own documents; an exact or regex answer states per shelf how many documents were searched and how many matched. `context` (0 to 3, exact and regex only) adds the lines around every hit as an index. ' +
      '`document_type` (a type key such as `fire_safety_concept`) and `refers_to` (a norm, a law, a plan number or a kind of ' +
      'document) narrow to the documents Piloti read to be that kind or to refer to that, inside the search. ' +
      'A search that stops at its limit says its counts are lower bounds. `group_by: "document"` (ranked search only) returns one ' +
      'entry per document, its best passage and how many passages of the ranked pool it held, for which documents deal with a topic. ' +
      'A query that names only a guideline (`OIB 2`) returns every part of it with its ' +
      'scope and outline. ' +
      'Returns the platform’s configured number of excerpts (16 unless raised, at most 50; the header counts them), each with source, citation key, document type, folder and page. ' +
      'A `Folder:` line after them is a folder whose summary matches: a pointer to look inside with files-list or `folder`, never a source. ' +
      'A hit marked as a Piloti document is knowledge the office approved, never a source for a normative value. When you know ' +
      'which document holds the answer, call passage-read instead; for Austrian law itself call law-lookup. Never invent a ' +
      'citation or a file name; an empty result says how to retry.',
    needsProject: true,
    projectOptionalForBase: true,
  },
  {
    name: 'passage-read',
    tool: 'read_passage',
    domain: 'knowledge',
    summary: 'Open one passage, page or outline of a named document',
    description:
      'Open a document you can already name. `document` alone returns its outline: the opening passage and a list of its ' +
      'top-level clauses with their pages. `document` with `clause` (a clause number such as `3.5.2`, a table caption, or the ' +
      'clause label a hit printed) or with `page` returns exactly that passage. `pages` (a range such as `4-6`, at most 30 pages) ' +
      'returns those pages in reading order without the overlap between neighbouring chunks, up to about 6k tokens; a read that ' +
      'stopped early ends with a `cursor`, which you pass back with the same `document` to continue. With the page count from ' +
      'files-list, request every range you need in one round. A deterministic lookup, not a search. Pass ' +
      '`document` exactly as files-list or a previous hit printed it (a file name or a display title). Call it when you know which ' +
      'document and want to know what it covers, or when a hit or a cross-reference points at a clause you have not read. ' +
      'Returns passages in document order, each with its ' +
      'source, citation key (quote it verbatim), document type, clause and page; an outline is an index, not evidence. An unknown ' +
      'name is refused with up to three close names to pass back exactly. When you do not know which document holds the answer, ' +
      'call knowledge-search.',
    needsProject: true,
  },
  {
    name: 'files-list',
    tool: 'list_files',
    domain: 'knowledge',
    summary: 'Browse the project’s and the office’s files by folder, name, type and date',
    description:
      'Browse the person’s own files as the Files pane shows them: which files exist, in which folder, of which document type, ' +
      'uploaded when. A deterministic, paged listing. Call it when the question is which files there are, not what they say, and ' +
      'first when you need an exact file name for passage-read or knowledge-search. No arguments: every file on the project, the ' +
      'office shelf and the conversation’s own files, by folder, after an overview of the top-level folders. Narrow with `folder`, ' +
      '`name_contains` (words that must all appear in the name or title), `doc_class`, `added_since` (YYYY-MM-DD), `sort: newest`, ' +
      '`topic`, or `shelf` (project, office_shelf, session, or base for the shared OIB corpus); page with `offset`. ' +
      '`view: tree` (with `depth` 1 to 4, default 2) returns a card per folder instead of file lines: counts, document-type mix, pages, ' +
      'dates and the current revision; use it for what is in a project or folder and which revision is current. ' +
      '`revisions_of` (a file name) lists that document’s revisions, newest first, with index or date, upload date and what ' +
      'changed; add `compare_to` (another revision’s file name, or `previous`) for what changed page by page. Returns one line per ' +
      'file: exact name, title, folder, document type, topics, revision mark, upload date and a one-line summary. An index, not a ' +
      'source: never cite it or answer what a file says from its summary. Copy file names exactly.',
    needsProject: true,
  },
  {
    name: 'document-look',
    tool: 'look',
    domain: 'knowledge',
    summary: 'Look at a page, a region of a page or an embedded image of a stored document',
    description:
      'See a stored document’s page, a region of it, or an image embedded in it, as an image you can inspect: a drawing, a ' +
      'section, a photo or a chart. `document` is a file name from files-list or from a hit’s citation line (not the display ' +
      'title), or a document id; the store it lives in is found for you. `page` starts at 1. `region: [x, y, w, h]` (shares ' +
      'of the page as shown, 0 to 1, origin top left) shows only that box, sharper; `image_index` (from a hit that names an ' +
      'embedded image) returns that image alone at its own resolution. On a large sheet look at the whole page once, then at ' +
      'one to three regions; a region costs about as much as a whole page and shows far more. Returns an image content ' +
      'block, or a sentence saying why it could not.',
    needsProject: true,
  },
  {
    name: 'ifc-query',
    tool: 'ifc_query',
    domain: 'bim',
    summary: 'Query the properties, quantities and classification of a project’s building model',
    description:
      'Query the project’s IFC (BIM) model for exact facts the export states: element counts, rooms and their areas, storeys, ' +
      'property values (fire rating, U-value, load-bearing), materials and classifications. Use it instead of knowledge-search when ' +
      'the question is about this building rather than a regulation. `operation`: `overview` (start here), `health` (the ' +
      'validation report: unassigned elements, rooms without area, missing property sets; read it before claiming coverage), ' +
      '`types`, `properties` (the model’s own property vocabulary with values and counts; call it before filtering on a ' +
      'property you have not seen), `elements`, `element` (one element by GlobalId), `schedule` (every room with storey, area and ' +
      'volume, with totals), `takeoff` (one quantity summed per type, optionally by material), `profile` (project facts the model ' +
      'implies, as proposals for a person to confirm), `compliance` (the OIB rule catalogue against the model: per requirement, ' +
      'how many elements are met, not met or undecidable, and which property would decide it; pass `building_class` 1 to 5 and ' +
      '`main_use`), `compliance-diff` and `compare` (against an older revision named by `compare_with`), and `aggregate` (count, ' +
      'sum, avg, min or max, optionally grouped). `filters` is a JSON object (`ifcTypes`, `storeys`, `nameContains`, `material`, ' +
      '`classification`, `properties` with operators eq, neq, contains, gt, gte, lt, lte, exists, missing); only elements, ' +
      'aggregate and takeoff take it, and an unknown key is rejected. Storey names match exactly: copy them from `overview`. ' +
      '`model_name` picks one model; without it only the project’s own is read, and an office-shelf model only when ' +
      'named. A compliance result is never a statement that the building ' +
      'complies: it reads published values only. A missing value is a fact about the export, not the building. Report numbers and ' +
      'caveat lines as returned; never recompute them.',
    needsProject: true,
  },
  {
    name: 'ifc-measure',
    tool: 'ifc_measure',
    domain: 'bim',
    summary:
      'Measure distances, areas, topology and spatial relations in a project’s building model',
    description:
      'Measure the project’s IFC (BIM) model: dimensions, distances, areas, clear heights and widths, and spatial relations, each ' +
      'with how it was obtained. Use it when the file does not state the number and the geometry has to be read, or to check a ' +
      'declared number another way; for counts and published values call bim-model-query first. Call `operation: "briefing"` ' +
      'first, once per model: it names the storeys, the property vocabulary this export used, and what this file cannot answer; ' +
      'copy storey and property names from it. Then `find_elements` for GlobalIds, `element`, `relations`, `measure` (one ' +
      'element or a known set), `survey` (one measure across a whole selection, with the spread: use it whenever the question is ' +
      'plural), `element_profile` (every measure that applies to one element), `distance` (centre to centre or between bounding ' +
      'boxes, never a clear dimension), `clearance` (the smallest surface-to-surface gap), `sun_position`, `storey_heights` ' +
      '(structural pitch, not clear room height), `room_inventory` (suspected room uses, a proposal), `fire` (OIB 2 geometry: a ' +
      'height, never a building class), `envelope` (OIB 6 geometry of the whole building; no U-value is calculated), `overhang`, ' +
      '`light_incidence` (the light prism over an opening, as geometry), `view` (a floor plan image for you to look at; never ' +
      'read a number off it), `draw` (the plan as an SVG file for the person) and `shopping_list` (the model’s blind spots as an ' +
      'IDS 1.0 file). Every answer says whether the value is declared by the file, computed from the geometry (with a tolerance ' +
      'to quote) or inferred (a proposal to confirm). `decidable: false` is a finding about the export: report what is missing ' +
      'and the remedy verbatim. Never recompute, round or convert a returned number, and pass only GlobalIds a call returned. ' +
      'A measurement that contradicts a declared quantity is reported as a contradiction with both numbers. The first ' +
      'geometric call on a model costs seconds; later calls are fast.',
    needsProject: true,
  },
  {
    name: 'law-lookup',
    tool: 'ris_lookup_tool',
    domain: 'knowledge',
    summary: 'Look up Austrian law in RIS and read the provision',
    description:
      'Answer a question about Austrian law from RIS, the federal legal information system, with the actual paragraphs, quotable ' +
      'and citable. Call it when the question turns on what an Austrian law says: the building codes and other state laws, the ' +
      'federal acts behind them, and court decisions; OIB guidelines become binding through these laws, so their binding force ' +
      'belongs here too. For the content of the OIB guidelines or the office’s documents, call knowledge-search. One call reads ' +
      'the address out of the question, finds the law, downloads at most two documents and cuts out the paragraphs that answer it. ' +
      '`question`: the legal question as the person means it, in German, the language of the law, not a list of search terms. ' +
      '`jurisdiction`: the federal state, when the person ' +
      'named one. `instrument`: an address when you have one (a law’s name or citation such as `§ 63 BO Wien`, a RIS document ' +
      'number or a ris.bka.gv.at URL); name every section you need in one call, up to six. `application`: only for case law, the ' +
      'gazettes or drafts; leave it empty for statute law. Returns numbered passages, each with its source, document type, clause, ' +
      'a citation key to quote verbatim and the paragraph text. A miss says what was searched and one concrete retry.',
    needsProject: false,
    // Reaches the public RIS, not only the office's own workspace.
    openWorld: true,
  },
] as const satisfies readonly Entry[]

/** The read tools' names, as a type (`exposure.config.ts` is keyed by it). */
export type BackendOperationName = (typeof ENTRIES)[number]['name']

/**
 * English for the German terms the fixture's input-schema descriptions carry, applied to every
 * `description` in a tool's schema (the property names, types and enums are the tool's and are not
 * touched). A new German term in a tool's schema fails `english-only.spec.ts`; add its gloss here.
 */
export const ENGLISH_GLOSSES: readonly (readonly [RegExp, string])[] = [
  [/OIB 2 \(Brandschutz\)/g, 'OIB 2 (fire safety)'],
  [/OIB 6 \(Wärmeschutz\)/g, 'OIB 6 (thermal protection)'],
  [/the Gebäudeklasse hangs on/g, 'the building class hangs on'],
  [/\(Brandübertragung\)/g, '(fire spread to a neighbour)'],
  [/\(unbestimmt, ausgeschlossen\)/g, '(undetermined, excluded)'],
  [/and unbestimmt \(/g, 'and undetermined ('],
  [/Brüstungs- und Sturzhöhe/g, 'sill and head height'],
  [/lichte Raumhöhe/g, 'clear room height'],
  [/a Raumhöhennachweis/g, 'a room-height check'],
  [/the LICHTE Breite and Höhe/g, 'the CLEAR width and height'],
  [/the Lichteinfallswinkel/g, 'the light-incidence angle'],
  [/the BESTIMMUNG/g, 'the PROVISION'],
  [/the lateral Verschwenkung/g, 'the lateral swivel'],
  [/a lichte Breite/g, 'a clear width'],
  [/a lichte Höhe/g, 'a clear height'],
  [/an Achsabstand/g, 'a centre-to-centre distance'],
  [/\(Achsabstand\)/g, '(centre to centre)'],
  [/a Fluchtweglänge/g, 'an escape-route length'],
  [/the NUTZBREITE/g, 'the USABLE WIDTH'],
  [/a Wendekreis check/g, 'a turning-circle check'],
  [/the Bestimmung/g, 'the provision'],
]

/** `schema` with {@link ENGLISH_GLOSSES} applied to every `description` in it. */
function glossed<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((item) => glossed(item)) as T
  if (typeof schema !== 'object' || schema === null) return schema
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === 'description' && typeof value === 'string'
        ? ENGLISH_GLOSSES.reduce((text, [german, english]) => text.replace(german, english), value)
        : glossed(value),
    ]),
  ) as T
}

const PROJECT_ID_SCHEMA = {
  type: 'string',
  description:
    'The project this call reads from, from project-list. The person must be able to chat in it.',
} as const

const OPTIONAL_PROJECT_ID_SCHEMA = {
  type: 'string',
  description:
    'The project this call reads from, from project-list. The person must be able to chat in it. ' +
    'Optional only with `shelf: "base"`, the shared building-law corpus, which belongs to no project.',
} as const

function withProjectId(schema: JsonSchemaObject, optional: boolean): JsonSchemaObject {
  return {
    ...schema,
    properties: {
      projectId: optional ? OPTIONAL_PROJECT_ID_SCHEMA : PROJECT_ID_SCHEMA,
      ...schema.properties,
    },
    required: [...(optional ? [] : ['projectId']), ...(schema.required ?? [])],
  }
}

/**
 * The Python tools take `conclusion`, a line Piloti's own turn shows the person
 * as its status ("looking for …"); it changes nothing the tool does. An outside
 * agent has no such status line, and a reasoning-shaped argument is one the
 * agent surface does not ask for, so the door's schema leaves it out.
 */
const STATUS_ONLY_ARGUMENTS = new Set(['conclusion'])

function withoutStatusArguments(schema: JsonSchemaObject): JsonSchemaObject {
  if (!schema.properties) return schema
  return {
    ...schema,
    properties: Object.fromEntries(Object.entries(schema.properties).filter(([key]) => !STATUS_ONLY_ARGUMENTS.has(key))),
    ...(schema.required ? { required: schema.required.filter((key) => !STATUS_ONLY_ARGUMENTS.has(key)) } : {}),
  }
}

function build(entry: Entry): BackendOperation {
  const tool = (backendTools.tools as readonly FixtureTool[]).find(
    (candidate) => candidate.name === entry.tool
  )
  // Fails the import, not a call: the contract and this table disagree.
  if (!tool)
    throw new Error(`backend-tools.schema.json has no tool ${entry.tool} (operation ${entry.name})`)
  const inputSchema = withoutStatusArguments(glossed(tool.inputSchema))
  return {
    name: entry.name,
    domain: entry.domain,
    summary: entry.summary,
    description: entry.description,
    tool: entry.tool,
    inputSchema: entry.needsProject
      ? withProjectId(inputSchema, entry.projectOptionalForBase === true)
      : inputSchema,
    annotations: { title: entry.summary, ...tool.annotations, openWorldHint: entry.openWorld ?? false },
    needsProject: entry.needsProject,
    ...(entry.projectOptionalForBase ? { projectOptionalForBase: true as const } : {}),
  }
}

/** Every read tool of the Python agent offered over MCP, in the contract's order. */
export const BACKEND_OPERATIONS: readonly BackendOperation[] = ENTRIES.map(build)

/**
 * The tool Piloti's own chat does an operation's work with, where it is not the tool the door calls.
 * Piloti reads the estate with the filesystem verbs (ADR-0133 slice 6), while the door keeps calling
 * the older tools, which deep research and intake still bind.
 */
export const AGENT_TOOL_FOR: Readonly<Record<string, string>> = { read_passage: 'read_file' }

/** The operation each Python tool is over MCP, for the names its answers mention. */
const OPERATION_NAMES: ToolNames = Object.fromEntries(ENTRIES.map((entry) => [entry.tool, entry.name]))

/**
 * A tool's text as an outside agent reads it: its next-call hints name the
 * operations (not the Python functions), and a ranked search says what its order means.
 */
export function doorText(
  op: Pick<BackendOperation, 'name'>,
  args: Record<string, unknown>,
  text: string,
): string {
  const named = withOperationNames(text, OPERATION_NAMES)
  const literal = args.match === 'exact' || args.match === 'regex'
  if (op.name !== 'knowledge-search') return named
  return literal ? named : fittedHits(withRankedOrderNote(named, args.group_by === 'document'))
}

/** `body` (the backend's `{ tool, result }`) with its text results put through {@link doorText}. */
function withDoorText(op: BackendOperation, args: Record<string, unknown>, body: unknown): unknown {
  if (typeof body !== 'object' || body === null || !('result' in body)) return body
  const result = (body as { result: unknown }).result
  const door = (text: string) => doorText(op, args, text)
  if (typeof result === 'string') return { ...body, result: door(result) }
  if (!Array.isArray(result)) return body
  return {
    ...body,
    result: result.map((block) =>
      block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
        ? { ...block, text: door(block.text) }
        : block,
    ),
  }
}

export function findBackendOperation(name: string): BackendOperation | undefined {
  return BACKEND_OPERATIONS.find((op) => op.name === name)
}

/** The backend answers within this, or the call is a 504. The BIM tools are the slow ones. */
const BACKEND_TOOL_TIMEOUT_MS = 120_000

const ENVELOPE_HEADERS = ['x-request-context', 'x-request-context-sig'] as const

/**
 * A refusal in the routes' error envelope (`{ error, code, details }`,
 * `errorResponse` in `lib/api/handler.ts`), so the agent surface words a
 * refusal from the backend exactly as one from a route.
 */
function refusal(status: number, code: string, message: string, details?: unknown): OperationResult {
  return { status, ok: false, body: { error: message, code, ...(details === undefined ? {} : { details }) } }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The backend's refusal (FastAPI: `{ detail: { error, issues?, tool? } }` or
 * `{ detail: "…" }`) in the routes' envelope, normalised once here. The code is
 * the backend's own (`invalid_arguments`, `tool_failed`); its `issues` become
 * `details`, which tell the agent which argument to fix.
 */
export function backendRefusal(status: number, body: unknown): OperationResult {
  const detail = isRecord(body) ? body.detail : undefined
  if (typeof detail === 'string' && detail.trim()) return refusal(status, `http_${status}`, detail)
  if (isRecord(detail) && typeof detail.error === 'string') {
    const said = typeof detail.detail === 'string' ? `: ${detail.detail}` : ''
    return refusal(status, detail.error, `The backend refused the call (${detail.error}${said})`, detail.issues)
  }
  return refusal(status, `http_${status}`, `The backend answered HTTP ${status}`)
}

/**
 * The context of a chat turn in `projectId` for `session`, signed: the two
 * envelope headers, and nothing else of a turn's headers. The backend takes the
 * person, the organization, the project and the scope from the envelope alone.
 */
async function signedEnvelope(
  session: AuthorizedSession,
  projectId: string | undefined,
  secret: string
): Promise<Record<string, string>> {
  const context = await resolveTurnContext(session, { projectId })
  const headers = turnContextHeaders(context, { issuedAt: Date.now(), secret })
  return Object.fromEntries(
    ENVELOPE_HEADERS.flatMap((name) => (headers[name] ? [[name, headers[name]]] : []))
  )
}

/**
 * Run one read tool as `session`, in `options.projectId`.
 *
 * Refusals come back as a result with a status, like {@link callOperation}'s:
 * 404 for a name that is not a backend operation, 400 for a project-scoped call
 * with no project, 403 when the person may not chat in the project, 429 when a
 * budget is spent, 503 when the BFF cannot sign or reach the backend, and the
 * backend's own status otherwise (422 for arguments the tool does not take).
 */
export async function callBackendOperation(
  name: string,
  args: Record<string, unknown>,
  session: AuthorizedSession,
  options: { projectId?: string }
): Promise<OperationResult> {
  const op = findBackendOperation(name)
  if (!op) return refusal(404, 'unknown_operation', `${name} is not a backend operation`)

  const projectId = options.projectId?.trim() || undefined
  const baseOnly = op.projectOptionalForBase === true && args.shelf === 'base'
  if (op.needsProject && !projectId && !baseOnly) {
    return refusal(
      400,
      'project_required',
      `${op.name} reads one project: pass projectId (from project-list)` +
        (op.projectOptionalForBase ? ', or shelf "base" for the shared building-law corpus' : '')
    )
  }

  // The token authenticates the call and is the key the envelope is signed with.
  const secret = process.env.INTERNAL_API_TOKEN
  const base = getBackendUrl()
  let tokenHeaders: Record<string, string>
  try {
    tokenHeaders = internalServiceHeaders(base)
  } catch (error) {
    if (!(error instanceof InternalServiceUnavailableError)) throw error
    return refusal(503, 'backend_not_configured', 'The BFF cannot sign a request to the backend')
  }
  if (!secret) return refusal(503, 'backend_not_configured', 'The BFF cannot sign a request to the backend')

  // Reads tenant rows with a session and no route around it, so the tenant is stated.
  const tenant = { organizationId: session.organizationId, userId: session.userId }
  let envelope: Record<string, string>
  try {
    envelope = await withTenant(tenant, async () => {
      // The gate first, so a refusal is a 403 and never a half-built context.
      if (projectId) await requireProjectAccess(session, projectId, CHAT_PERMISSIONS)
      return signedEnvelope(session, projectId, secret)
    })
  } catch (error) {
    if (error instanceof TurnBudgetExhaustedError)
      return refusal(429, 'budget_exhausted', error.message)
    // Not found and not allowed are one answer: it must not confirm a project exists.
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return refusal(403, 'forbidden', 'You cannot use this project')
    }
    throw error
  }

  // The project rides in the signed envelope. A copy among the arguments would
  // be a second, unsigned claim about the same thing.
  const { projectId: _ignored, ...toolArguments } = args

  try {
    const response = await fetch(`${base}/v1/internal/tools/${encodeURIComponent(op.tool)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...envelope, ...tokenHeaders },
      body: JSON.stringify({ arguments: toolArguments }),
      cache: 'no-store',
      // A redirect would replay the internal token at whatever host the response names.
      redirect: 'error',
      signal: AbortSignal.timeout(BACKEND_TOOL_TIMEOUT_MS),
    })
    // The routes' reader, with its 5 MiB cap: a tool's answer is read no further than a route's.
    const body = await readResponseBody(response)
    return response.ok
      ? { status: response.status, ok: true, body: withDoorText(op, toolArguments, body) }
      : backendRefusal(response.status, body)
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return timedOut
      ? refusal(504, 'backend_timeout', `${op.name} did not answer in time`)
      : refusal(503, 'backend_unreachable', 'The backend did not answer')
  }
}

/** One block of a tool's result, as MCP `CallToolResult.content` carries it. */
export type McpContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }

const DATA_URL = /^data:([^;,]+);base64,([\s\S]*)$/

/**
 * A tool's `result` (text, or the content blocks the page-image tool answers
 * with) as MCP content blocks: text stays text, an `image_url` data URL becomes
 * an image block, anything else is shown as JSON.
 */
export function toMcpContent(result: unknown): McpContentBlock[] {
  if (typeof result === 'string') return [{ type: 'text', text: result }]
  if (!Array.isArray(result)) return [{ type: 'text', text: JSON.stringify(result) }]
  return result.map((block): McpContentBlock => {
    if (block && typeof block === 'object') {
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string')
        return { type: 'text', text: record.text }
      const url = (record.image_url as { url?: unknown } | undefined)?.url
      const match =
        record.type === 'image_url' && typeof url === 'string' ? DATA_URL.exec(url) : null
      if (match) return { type: 'image', mimeType: match[1] as string, data: match[2] as string }
    }
    return { type: 'text', text: JSON.stringify(block) }
  })
}
