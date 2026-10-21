/**
 * @vitest-environment node
 */
/**
 * The agent-reachability gate (ADR-0121): everything a person can do in
 * Piloti, an agent can do through Piloti's MCP server.
 *
 * It walks every `app/api/**\/route.ts` the way `authz-coverage.spec.ts` does
 * and asserts:
 *
 *   1. Every person-facing route method is in the catalog (`AGENT_OPERATIONS`),
 *      exempt in {@link NOT_AN_AGENT_CAPABILITY} with a reason, or still
 *      listed in the baseline of routes that predate the rule.
 *   2. The baseline only shrinks: a route that is now covered, or gone, must
 *      leave it. `UPDATE_FIXTURES=1` rewrites it, and the diff is the review.
 *   3. Every operation is well formed: a unique `<entity>-<verb>` name, a
 *      description a model can act on, a `load` that imports the route its
 *      `path` names, params that match the path's segments, and schemas the
 *      JSON Schema export can describe.
 *
 * A new route without an agent door fails here, in the commit that adds it.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { toJsonSchema } from '@/lib/api/zod-json-schema'
import { AGENT_OPERATIONS } from './catalog'
import { type Sensitivity, pathParams } from './operation'

const HERE = dirname(fileURLToPath(import.meta.url))
const API_DIR = join(HERE, '../../app/api')
const CATALOG_DIR = join(HERE, 'catalog')
const BASELINE_FILE = join(HERE, 'agent-reachability-baseline.json')

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/**
 * Route methods that are not something a person does, each with the reason.
 * Keyed `METHOD /api/path`, or `* /api/path` for every method of a route.
 * Growing this map needs the same kind of sentence its entries carry.
 */
const NOT_AN_AGENT_CAPABILITY: Record<string, string> = {
  '* /api/auth/callback': 'the AuthKit OAuth callback; it creates the browser session an agent does not have',
  '* /api/auth/signin': 'the browser sign-in redirect; an agent signs in through MCP OAuth instead',
  '* /api/auth/websocket-scope': 'mints WebSocket scope headers for the browser’s chat socket; transport, not an act',
  '* /api/auth/connection-diagnostics': 'diagnoses the browser’s own connection to AuthKit; meaningless for an agent',
  '* /api/stream': 'the browser’s server-sent event stream; an agent reads state through operations instead',
  '* /api/realtime': 'the browser’s live channel (presence, typing); transport, not an act',
  '* /api/realtime/send': 'the browser’s live channel (presence, typing); transport, not an act',
  '* /api/conversations/[id]/typing': 'a typing indicator for the person at the keyboard; an agent has no keyboard',
  '* /api/conversations/[id]/live': 'the browser’s server-sent event stream of a turn; an agent reads messages instead',
  '* /api/conversations/[id]/frames': 'lets the browser resume its chat socket where it dropped; transport, not an act',
  '* /api/conversations/[id]/messages/[messageId]/stopped':
    'cuts an answer to the text the Stop button had on screen; only the browser knows what it showed',
  'POST /api/notifications/push/devices': 'registers this browser’s Web Push subscription; an agent has no browser to notify',
  '* /api/notifications/push/config': 'the VAPID public key a browser subscribes with; transport, not an act',
  '* /api/mcp': 'the MCP endpoint itself: it is the door every operation here goes through',
  '* /api/a2a':
    'the A2A endpoint (ADR-0122): another protocol onto the piloti-ask operations, which an MCP client calls directly',
  '* /api/v1/[...path]': 'transport proxy to the backend; the capabilities behind it are catalogued at their own routes',
  '* /api/jobs/async/[...path]': 'transport proxy to the job API; starting and steering runs is catalogued at the task routes',
  '* /api/dictation': 'speech-to-text for the person’s microphone; an agent sends text',
  '* /api/openapi': 'the machine-readable description of these operations; an agent reads it through describe-operation instead',
}

/**
 * Every route method an agent reaches only under the extra guards of ADR-0121
 * ("Sensitive operations"), with its class: `access` changes who may see or do
 * what, `secret` touches the organization's credentials. Each is catalogued
 * with exactly this `sensitivity`, and nothing else carries one, so a grant of
 * access cannot become a plain operation, nor a plain one a guarded one, without
 * a line here. Keyed `METHOD /api/path`.
 */
const SENSITIVE: Record<string, Sensitivity> = {
  'PUT /api/projects/[id]/folders/[folderId]/access': 'access',
  'PATCH /api/sharing/[resourceType]/[resourceId]': 'access',
  'POST /api/sharing/[resourceType]/[resourceId]/grants': 'access',
  'PATCH /api/sharing/[resourceType]/[resourceId]/grants': 'access',
  'DELETE /api/sharing/[resourceType]/[resourceId]/grants/[subjectUserId]': 'access',
  'POST /api/organization/roles': 'access',
  'PATCH /api/organization/roles/[slug]': 'access',
  'DELETE /api/organization/roles/[slug]': 'access',
  'GET /api/organization/llm-credentials': 'secret',
  'POST /api/organization/llm-credentials': 'secret',
  'DELETE /api/organization/llm-credentials/[id]': 'secret',
  'POST /api/organization/llm-credentials/[id]/verify': 'secret',
  'PUT /api/organization/llm-credentials/mode': 'secret',
  'POST /api/organization/audit-portal': 'secret',
  'POST /api/platform/audit-portal': 'secret',
}

interface RouteMethod {
  readonly key: string
  readonly path: string
  readonly method: string
  readonly file: string
}

function findRouteFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findRouteFiles(path))
    else if (entry.name === 'route.ts') found.push(path)
  }
  return found
}

function apiPathOf(file: string): string {
  const dir = dirname(relative(API_DIR, file)).split('\\').join('/')
  return dir === '.' ? '/api' : `/api/${dir}`
}

/**
 * Every method a PERSON can call: what `internalApiRoute` (a service's door)
 * and `publicApiRoute` (health, signed images) export is not a person's act.
 */
function personFacingRouteMethods(): RouteMethod[] {
  const found: RouteMethod[] = []
  for (const file of findRouteFiles(API_DIR)) {
    const source = readFileSync(file, 'utf8')
    const path = apiPathOf(file)
    for (const method of METHODS) {
      const exported = new RegExp(`export\\s+(?:const\\s+${method}\\s*=\\s*(\\w+)|async\\s+function\\s+${method}\\s*\\()`)
      const match = source.match(exported)
      if (!match) continue
      if (match[1] === 'internalApiRoute' || match[1] === 'publicApiRoute') continue
      found.push({ key: `${method} ${path}`, path, method, file })
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key))
}

function listedIn(map: Record<string, string>, route: RouteMethod): boolean {
  return route.key in map || `* ${route.path}` in map
}

function isExempt(route: RouteMethod): boolean {
  return listedIn(NOT_AN_AGENT_CAPABILITY, route)
}

const ROUTES = personFacingRouteMethods()
const COVERED = new Set(AGENT_OPERATIONS.map((op) => `${op.method} ${op.path}`))
const UNCOVERED = ROUTES.filter((route) => !COVERED.has(route.key) && !isExempt(route)).map((r) => r.key)

function readBaseline(): string[] {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as string[]
  } catch {
    return []
  }
}

if (process.env.UPDATE_FIXTURES === '1') {
  writeFileSync(BASELINE_FILE, `${JSON.stringify(UNCOVERED, null, 2)}\n`)
}

describe('every person-facing route is agent-reachable (ADR-0121)', () => {
  const baseline = new Set(readBaseline())

  it('finds the routes', () => {
    expect(ROUTES.length).toBeGreaterThan(200)
  })

  it('a route added since the rule has an operation or a stated exemption', () => {
    const added = UNCOVERED.filter((key) => !baseline.has(key))
    expect(
      added,
      'Add an operation to lib/agent-api/catalog/<domain>.ts, or a reason to NOT_AN_AGENT_CAPABILITY. ' +
        'See docs/architecture/agent-surface.md.',
    ).toEqual([])
  })

  it('the baseline only shrinks: covered or deleted routes leave it', () => {
    const stillUncovered = new Set(UNCOVERED)
    const stale = [...baseline].filter((key) => !stillUncovered.has(key))
    expect(stale, 'Remove these from agent-reachability-baseline.json (UPDATE_FIXTURES=1 rewrites it).').toEqual([])
  })

  it('a sensitive capability is catalogued with exactly its class, and nothing else carries one', () => {
    const catalogued = Object.fromEntries(
      AGENT_OPERATIONS.filter((op) => op.sensitivity).map((op) => [`${op.method} ${op.path}`, op.sensitivity]),
    )
    expect(catalogued).toEqual(SENSITIVE)
  })

  it('every exemption names a route that exists, with a reason', () => {
    const paths = new Set(ROUTES.map((route) => route.path))
    const keys = new Set(ROUTES.map((route) => route.key))
    for (const key of Object.keys(SENSITIVE)) expect(keys.has(key), `${key} matches no route`).toBe(true)
    for (const [key, reason] of Object.entries(NOT_AN_AGENT_CAPABILITY)) {
      expect(reason.length, key).toBeGreaterThan(30)
      const [method, path] = key.split(' ') as [string, string]
      // The MCP route answers with its own factory-less handler, so it may not
      // be a person-facing method yet while it is being added.
      if (path === '/api/mcp') continue
      expect(method === '*' ? paths.has(path) : keys.has(key), `${key} matches no route`).toBe(true)
    }
  })
})

describe('the catalog is well formed', () => {
  const routeKeys = new Set(ROUTES.map((route) => route.key))
  const catalogSource = readdirSync(CATALOG_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map((file) => readFileSync(join(CATALOG_DIR, file), 'utf8'))
    .join('\n')

  it('names are unique kebab-case <entity>-<verb>, at most 52 characters', () => {
    const names = AGENT_OPERATIONS.map((op) => op.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name, name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/)
      expect(name.length, name).toBeLessThanOrEqual(52)
    }
  })

  it('every operation names a route method that exists', () => {
    for (const op of AGENT_OPERATIONS) {
      expect(routeKeys.has(`${op.method} ${op.path}`), `${op.name}: ${op.method} ${op.path}`).toBe(true)
    }
  })

  it('two operations never share one route method', () => {
    const keys = AGENT_OPERATIONS.map((op) => `${op.method} ${op.path}`)
    const repeated = keys.filter((key, index) => keys.indexOf(key) !== index)
    expect(repeated).toEqual([])
  })

  it('load imports the route its path names', () => {
    for (const op of AGENT_OPERATIONS) {
      // The operation's own entry: from its name to the next entry's name.
      const block = catalogSource.slice(catalogSource.indexOf(`name: '${op.name}',`))
      const next = block.indexOf("name: '", 10)
      const entry = next > 0 ? block.slice(0, next) : block
      expect(entry.includes(`load: () => import('@/app${op.path}/route')`), op.name).toBe(true)
    }
  })

  it('params match the path segments', () => {
    for (const op of AGENT_OPERATIONS) {
      const declared = Object.keys(op.params?.shape ?? {}).sort()
      expect(declared, op.name).toEqual([...pathParams(op.path)].sort())
    }
  })

  it('descriptions tell a model when to call it', () => {
    for (const op of AGENT_OPERATIONS) {
      expect(op.summary.length, op.name).toBeGreaterThan(8)
      expect(op.description.length, op.name).toBeGreaterThanOrEqual(40)
    }
  })

  it('every input schema exports to JSON Schema', () => {
    for (const op of AGENT_OPERATIONS) {
      for (const schema of [op.params, op.query, op.body]) {
        if (schema) expect(() => toJsonSchema(schema), op.name).not.toThrow()
      }
    }
  })
})
