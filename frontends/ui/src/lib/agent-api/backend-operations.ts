import 'server-only'
/**
 * The agent's read tools, offered to other agents over MCP (ADR-0121).
 *
 * `catalog/` covers what the BFF's routes do. Piloti's best READ tools live
 * only in the Python agent: knowledge search, passage reading, the file
 * browser, page images, the two BIM tools and RIS. An outside agent must get
 * them too, so each is an operation here, and the MCP server lists them beside
 * the catalog's. A call goes to the backend's `POST /v1/internal/tools/{name}`
 * (`frontends/aiq_api/src/aiq_api/routes/internal_tools.py`).
 *
 * Nothing is described twice. The tool's description and input schema are the
 * ones the chat model reads, generated from the Python functions into
 * `tests/fixtures/backend-tools.schema.json` (`scripts/generate_backend_tools_schema.py`,
 * held current by `tests/aiq_agent/common/test_backend_tools_schema.py`). This
 * file adds only what is the BFF's to say: the MCP name, the domain, and
 * whether the tool needs a project.
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
import { isTokenSafeDestination } from '@/lib/model-config/backend-defaults'
import { resolveTurnContext, TurnBudgetExhaustedError } from '@/lib/turns/turn-context'
import { turnContextHeaders } from '@/lib/turns/turn-headers.js'
import backendTools from '../../../tests/fixtures/backend-tools.schema.json'
import type { AgentDomain, ToolAnnotations } from './operation'
import type { OperationResult } from './dispatch'

export type { OperationResult }

/** A JSON Schema object, as the fixture carries it and the MCP `tools/list` shows it. */
export interface JsonSchemaObject {
  readonly type: 'object'
  readonly properties?: Record<string, unknown>
  readonly required?: readonly string[]
  readonly [keyword: string]: unknown
}

export interface BackendOperation {
  /** `<entity>-<verb>`, kebab-case, unique across the catalog as well. */
  readonly name: string
  readonly domain: Extract<AgentDomain, 'knowledge' | 'bim'>
  /** One line for `tools` and `search`. */
  readonly summary: string
  /** The description the chat model reads, verbatim from the Python function. */
  readonly description: string
  /** The Python function's name: the path segment of the backend route. */
  readonly tool: string
  /** The tool's input schema, with `projectId` added in front when the tool is project-scoped. */
  readonly inputSchema: JsonSchemaObject
  readonly annotations: ToolAnnotations
  /** The call is scoped to a project, which the person must be able to chat in. */
  readonly needsProject: boolean
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
  readonly needsProject: boolean
}

const ENTRIES: readonly Entry[] = [
  {
    name: 'knowledge-search',
    tool: 'knowledge_search',
    domain: 'knowledge',
    summary:
      'Search the project’s, the office’s and the building-law documents for quotable passages',
    needsProject: true,
  },
  {
    name: 'passage-read',
    tool: 'read_passage',
    domain: 'knowledge',
    summary: 'Open one passage, page or outline of a named document',
    needsProject: true,
  },
  {
    name: 'files-list',
    tool: 'list_files',
    domain: 'knowledge',
    summary: 'Browse the project’s and the office’s files by folder, name, type and date',
    needsProject: true,
  },
  {
    name: 'knowledge-image-view',
    tool: 'view_knowledge_image',
    domain: 'knowledge',
    summary: 'See a page or a region of a stored document as an image',
    needsProject: true,
  },
  {
    name: 'ifc-query',
    tool: 'ifc_query',
    domain: 'bim',
    summary: 'Query the properties, quantities and classification of a project’s building model',
    needsProject: true,
  },
  {
    name: 'ifc-measure',
    tool: 'ifc_measure',
    domain: 'bim',
    summary:
      'Measure distances, areas, topology and spatial relations in a project’s building model',
    needsProject: true,
  },
  {
    name: 'law-lookup',
    tool: 'ris_lookup_tool',
    domain: 'knowledge',
    summary: 'Look up Austrian law in RIS and read the provision',
    needsProject: false,
  },
]

const PROJECT_ID_SCHEMA = {
  type: 'string',
  description:
    'The project this call reads from, from project-list. The person must be able to chat in it.',
} as const

function withProjectId(schema: JsonSchemaObject): JsonSchemaObject {
  return {
    ...schema,
    properties: { projectId: PROJECT_ID_SCHEMA, ...schema.properties },
    required: ['projectId', ...(schema.required ?? [])],
  }
}

function build(entry: Entry): BackendOperation {
  const tool = (backendTools.tools as readonly FixtureTool[]).find(
    (candidate) => candidate.name === entry.tool
  )
  // Fails the import, not a call: the contract and this table disagree.
  if (!tool)
    throw new Error(`backend-tools.schema.json has no tool ${entry.tool} (operation ${entry.name})`)
  return {
    name: entry.name,
    domain: entry.domain,
    summary: entry.summary,
    description: tool.description,
    tool: entry.tool,
    inputSchema: entry.needsProject ? withProjectId(tool.inputSchema) : tool.inputSchema,
    annotations: { title: entry.summary, ...tool.annotations },
    needsProject: entry.needsProject,
  }
}

/** Every read tool of the Python agent offered over MCP, in the contract's order. */
export const BACKEND_OPERATIONS: readonly BackendOperation[] = ENTRIES.map(build)

export function findBackendOperation(name: string): BackendOperation | undefined {
  return BACKEND_OPERATIONS.find((op) => op.name === name)
}

/** The backend answers within this, or the call is a 504. The BIM tools are the slow ones. */
const BACKEND_TOOL_TIMEOUT_MS = 120_000

const ENVELOPE_HEADERS = ['x-grid-request-context', 'x-grid-request-context-sig'] as const

function refusal(status: number, error: string, message: string): OperationResult {
  return { status, ok: false, body: { error, message } }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
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
  if (op.needsProject && !projectId) {
    return refusal(
      400,
      'project_required',
      `${op.name} reads one project: pass projectId (from project-list)`
    )
  }

  const secret = process.env.GRID_INTERNAL_API_TOKEN
  const base = (process.env.BACKEND_URL ?? 'http://localhost:8000').replace(/\/$/, '')
  if (!secret || !isTokenSafeDestination(base)) {
    return refusal(503, 'backend_not_configured', 'The BFF cannot sign a request to the backend')
  }

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
      headers: { 'content-type': 'application/json', 'x-grid-internal-token': secret, ...envelope },
      body: JSON.stringify({ arguments: toolArguments }),
      cache: 'no-store',
      // A redirect would replay the internal token at whatever host the response names.
      redirect: 'error',
      signal: AbortSignal.timeout(BACKEND_TOOL_TIMEOUT_MS),
    })
    return { status: response.status, ok: response.ok, body: await readBody(response) }
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
