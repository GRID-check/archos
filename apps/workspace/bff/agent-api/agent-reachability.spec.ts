// @disk-inputs: app/api/**, bff/agent-api/agent-reachability-baseline.json, bff/agent-api/catalog/**
/**
 * @vitest-environment node
 */
/**
 * The agent-reachability gate (ADR-0122): everything a person can do in
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
import { AGENT_OPERATIONS, RENAMED_OPERATIONS, findOperation, renamedTo } from './catalog'
import { isOnDoor } from './exposure'
import { EXPOSURE, type Exposure, type WithheldCategory } from './exposure.config'
import { validateOperationInput } from './dispatch'
import { type Sensitivity, pathParams, withInputDefaults } from './operation'

const HERE = dirname(fileURLToPath(import.meta.url))
const API_DIR = join(HERE, '../../app/api')
const CATALOG_DIR = join(HERE, 'catalog')
const BASELINE_FILE = join(HERE, 'agent-reachability-baseline.json')

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/**
 * Why a route or an operation is not on the agent door, in the categories of
 * ADR-0122's amendment: the withheld ones (`WithheldCategory`), plus `other`
 * for what is not an act at all (transport, sign-in plumbing, the doors themselves).
 */
type ExemptionCategory = WithheldCategory | 'other'

interface Exemption {
  readonly category: ExemptionCategory
  readonly reason: string
}

/**
 * Route methods that are not something a person does, each with its category
 * and reason. Keyed `METHOD /api/path`, or `* /api/path` for every method of a
 * route. Growing this map needs the same kind of sentence its entries carry. A
 * capability a person has but an agent should not be offered is not exempt
 * here: it is catalogued and withheld in `exposure.config.ts`.
 */
const NOT_AN_AGENT_CAPABILITY: Record<string, Exemption> = {
  'POST /api/documents/[id]/sketch/edits/preview': {
    category: 'ui-state',
    reason:
      'the receipt card’s picture of a proposed sketch edit; an agent gets the same diff and warnings from document-sketch-edit, Piloti from the proposal check',
  },
  'GET /api/ris/document': {
    category: 'external-service',
    reason: 'the RIS text dialog proxies the public legal text service; an agent reads a RIS document by number or URL through law-lookup (`instrument`)',
  },
  '* /api/auth/callback': {
    category: 'other',
    reason: 'the AuthKit OAuth callback; it creates the browser session an agent does not have',
  },
  '* /api/auth/signin': {
    category: 'other',
    reason: 'the browser sign-in redirect; an agent signs in through MCP OAuth instead',
  },
  '* /api/auth/websocket-scope': {
    category: 'other',
    reason: 'mints WebSocket scope headers for the browser’s chat socket; transport, not an act',
  },
  '* /api/auth/connection-diagnostics': {
    category: 'other',
    reason: 'diagnoses the browser’s own connection to AuthKit; meaningless for an agent',
  },
  '* /api/stream': {
    category: 'other',
    reason: 'the browser’s server-sent event stream; an agent reads state through operations instead',
  },
  '* /api/realtime': {
    category: 'other',
    reason: 'the browser’s live channel (presence, typing); transport, not an act',
  },
  '* /api/realtime/send': {
    category: 'ui-state',
    reason: 'the browser’s live channel (presence, typing); transport, not an act',
  },
  '* /api/conversations/[id]/typing': {
    category: 'ui-state',
    reason: 'a typing indicator for the person at the keyboard; an agent has no keyboard',
  },
  '* /api/conversations/[id]/live': {
    category: 'other',
    reason: 'the browser’s server-sent event stream of a turn; an agent reads messages instead',
  },
  '* /api/conversations/[id]/frames': {
    category: 'other',
    reason: 'lets the browser resume its chat socket where it dropped; transport, not an act',
  },
  '* /api/conversations/[id]/messages/[messageId]/stopped': {
    category: 'ui-state',
    reason: 'cuts an answer to the text the Stop button had on screen; only the browser knows what it showed',
  },
  'POST /api/notifications/push/devices': {
    category: 'ui-state',
    reason: 'registers this browser’s Web Push subscription; an agent has no browser to notify',
  },
  '* /api/notifications/push/config': {
    category: 'other',
    reason: 'the VAPID public key a browser subscribes with; transport, not an act',
  },
  '* /api/mcp': {
    category: 'other',
    reason: 'the MCP endpoint itself: it is the door every operation here goes through',
  },
  '* /api/platform/mcp': {
    category: 'other',
    reason: 'the platform door (ADR-0126): the MCP endpoint for the operator console, through which the platform operations are called',
  },
  '* /api/a2a': {
    category: 'other',
    reason: 'the A2A endpoint (ADR-0124): another protocol onto the piloti-ask operations, which an MCP client calls directly',
  },
  '* /api/v1/[...path]': {
    category: 'other',
    reason: 'transport proxy to the backend; the capabilities behind it are catalogued at their own routes',
  },
  '* /api/jobs/async/[...path]': {
    category: 'other',
    reason: 'transport proxy to the job API; starting and steering runs is catalogued at the task routes',
  },
  '* /api/dictation': {
    category: 'model-compute',
    reason: 'speech-to-text for the person’s microphone; an agent sends text',
  },
  '* /api/openapi': {
    category: 'other',
    reason: 'the machine-readable description of these operations; an agent reads it through describe-operation instead',
  },
}

/**
 * Every route method an agent reaches only under the extra guards of ADR-0122
 * ("Sensitive operations"), with its class: `access` changes who may see or do
 * what, `secret` touches the organization's credentials, `control` turns a
 * security or compliance control down or off. Each is catalogued
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
  // A project role up to project-admin is a grant of access like any folder grant.
  'POST /api/projects/[id]/members': 'access',
  'DELETE /api/projects/[id]/members/[assignmentId]': 'access',
  'GET /api/organization/llm-credentials': 'secret',
  'POST /api/organization/llm-credentials': 'secret',
  'DELETE /api/organization/llm-credentials/[id]': 'secret',
  'POST /api/organization/llm-credentials/[id]/verify': 'secret',
  'PUT /api/organization/llm-credentials/mode': 'secret',
  'POST /api/organization/audit-portal': 'secret',
  'POST /api/platform/audit-portal': 'secret',
  'PUT /api/organization/model-config/zdr': 'control',
  'PUT /api/organization/upload-screening': 'control',
  'PUT /api/projects/[id]/upload-screening': 'control',
  'POST /api/documents/[id]/quarantine/release': 'control',
  'POST /api/holds/[id]/release': 'control',
  'PUT /api/organization/download-log/retention': 'control',
  'PUT /api/organization/deleted-folder-content': 'control',
  'PUT /api/organization/web-search': 'control',
}

/**
 * Where product configuration and a person's own screen state live. An
 * operation on one of these paths that an office door offers fails, unless its
 * entry in `exposure.config.ts` gives the `reason`: how Piloti itself works for
 * the office is not a thing the door hands to another agent, and it must not
 * drift back in with a new operation nobody marked.
 */
const CONFIG_PATH_PREFIXES = [
  '/api/organization/settings',
  '/api/organization/instructions',
  '/api/organization/web-search',
  '/api/organization/model-config',
  '/api/organization/llm-credentials',
  '/api/organization/budgets',
  '/api/organization/usage',
  '/api/organization/upload-screening',
  '/api/projects/[id]/upload-screening',
  '/api/organization/deleted-folder-content',
  '/api/organization/download-log/retention',
  '/api/organization/audit-portal',
  '/api/skills/curated',
  '/api/notifications/push',
  '/api/user/preferences',
  '/api/platform',
] as const

const underPrefix = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`)

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

function listedIn(map: Record<string, unknown>, route: RouteMethod): boolean {
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

describe('every person-facing route is agent-reachable (ADR-0122)', () => {
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
    for (const [key, { reason }] of Object.entries(NOT_AN_AGENT_CAPABILITY)) {
      expect(reason.length, key).toBeGreaterThan(30)
      const [method, path] = key.split(' ') as [string, string]
      // The MCP route answers with its own factory-less handler, so it may not
      // be a person-facing method yet while it is being added.
      if (path === '/api/mcp') continue
      expect(method === '*' ? paths.has(path) : keys.has(key), `${key} matches no route`).toBe(true)
    }
  })
})

describe('what the door offers (ADR-0122, amendments of 2026-10-21)', () => {
  const entry = (name: string): Exposure => (EXPOSURE as Readonly<Record<string, Exposure>>)[name] as Exposure
  const offered = AGENT_OPERATIONS.filter((op) => isOnDoor(op.name))

  it('withholds an operation only with a category and a reason of its own', () => {
    for (const op of AGENT_OPERATIONS) {
      const withheld = entry(op.name).withheld
      if (withheld) expect(withheld.reason.length, op.name).toBeGreaterThan(30)
    }
  })

  it('offers no product configuration or screen state on an office door without a stated reason', () => {
    const config = offered
      .filter((op) => CONFIG_PATH_PREFIXES.some((prefix) => underPrefix(op.path, prefix)))
      .filter((op) => !entry(op.name).reason)
      .map((op) => op.name)
    expect(
      config,
      'Withhold it in exposure.config.ts (`withheld: { category, reason }`), or give its entry the `reason` it is office work.',
    ).toEqual([])
  })

  it('keeps the operator console on its own door: every /api/platform operation is the platform domain, and only those', () => {
    for (const op of AGENT_OPERATIONS) {
      expect(op.domain === 'platform', op.name).toBe(underPrefix(op.path, '/api/platform'))
    }
    // The config's side of the same rule (`platform: true` exactly for that domain) is exposure.config.spec.ts's.
    expect(AGENT_OPERATIONS.filter((op) => op.domain === 'platform' && isOnDoor(op.name, 'office')).map((op) => op.name)).toEqual([])
  })

  it('never sends an agent to a withheld operation: no offered text names one', () => {
    const withheld = AGENT_OPERATIONS.filter((op) => entry(op.name).withheld).map((op) => op.name)
    for (const op of offered) {
      const text = [op.summary, op.description, ...[op.params, op.query, op.body].map((schema) => (schema ? JSON.stringify(toJsonSchema(schema)) : ''))].join(' ')
      const named = withheld.filter((name) => new RegExp(`(^|[^a-z-])${name}($|[^a-z-])`).test(text))
      expect(named, op.name).toEqual([])
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

describe('renamed operations (one release)', () => {
  it('lead from a name no operation has to one that exists, and resolve to it', () => {
    const names = new Set(AGENT_OPERATIONS.map((op) => op.name))
    for (const old of Object.keys(RENAMED_OPERATIONS)) {
      const current = renamedTo(old) ?? ''
      expect(names.has(current), `${old} -> ${current}`).toBe(true)
      expect(names.has(old), old).toBe(false)
      expect(findOperation(old)?.name).toBe(current)
    }
  })

  it('carry the input an old name stood for, under what the caller sends', () => {
    const list = findOperation('office-shelf-document-list')
    expect(list?.inputDefaults).toEqual({ query: { scope: 'office_shelf' } })
    expect(findOperation('document-list')?.inputDefaults).toBeUndefined()
    const withDefaults = (op: typeof list, input: Parameters<typeof withInputDefaults>[0]) =>
      withInputDefaults(input, op?.inputDefaults)
    expect(withDefaults(list, { query: { limit: 10 } })).toEqual({ query: { scope: 'office_shelf', limit: 10 } })
    expect(withDefaults(list, { query: { scope: 'project', projectId: 'p1' } }).query).toEqual({ scope: 'project', projectId: 'p1' })
    const upload = findOperation('office-shelf-document-upload')
    expect(withDefaults(upload, { body: { files: [], fields: { folderId: 'f1' } } }).body).toEqual({
      files: [],
      fields: { scope: 'office_shelf', folderId: 'f1' },
    })
  })

  it('ask the one search what document-search asked, its fields under their new names', () => {
    const projectId = '0b6f0c1e-3a55-4c0e-9a1d-7f2b5d0e1a01'
    expect(validateOperationInput(findOperation('document-search')!, { body: { q: 'Fluchtweg', topK: 10, projectId } })).toEqual({
      query: { projectId },
      body: { text: 'Fluchtweg', limit: 10, kinds: ['document'], facets: false },
    })
    expect(validateOperationInput(findOperation('office-shelf-document-search')!, { body: { q: 'Fluchtweg' } })).toEqual({
      query: { scope: 'office_shelf' },
      body: { text: 'Fluchtweg', kinds: ['document'], facets: false },
    })
  })
})
