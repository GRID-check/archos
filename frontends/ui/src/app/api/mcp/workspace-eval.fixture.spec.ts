/**
 * @vitest-environment node
 */
/**
 * The workspace eval's catalog, written by the production code
 * (`task be:eval:answer-suite -- --set workspace`, ADR-0122). What in-product
 * Piloti sees on its MCP door — every operation it may name, and what
 * `describe-operation` answers for each — is written to
 * `tests/fixtures/workspace/catalog.json`, which
 * `scripts/turn_census/fixture_workspace.py` serves. Beside it, what
 * `search-operations` returns for a fixed set of queries, English and German:
 * the fixture ranks with a Python mirror of the server's ranking
 * (`lib/text/operation-search.ts`, which `discovery.ts` ranks with), and
 * `tests/test_workspace_eval.py` holds that mirror to these lists.
 *
 * A change to the catalog, to a description or to the ranking fails here until
 * the fixture is regenerated, so the eval never measures a door production no
 * longer has:
 *
 *   UPDATE_FIXTURES=1 npx vitest run src/app/api/mcp/workspace-eval.fixture.spec.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/agent-api/telemetry', () => ({ recordOperationCalled: vi.fn(), recordCapabilityMissing: vi.fn() }))

import { describeOperation, searchOperations } from '@/lib/agent-api/discovery'
import { annotationsOf } from '@/lib/agent-api/operation'
import { visibleOperations } from '@/lib/agent-api/policy'
import type { AgentPrincipal } from '@/lib/agent-api/principal'

const FILE = join(process.cwd(), 'tests/fixtures/workspace/catalog.json')
const LIMIT = 10

const session = {
  userId: 'user_eval',
  email: 'eval@piloti.test',
  name: 'Eval',
  accessToken: '',
  organizationId: 'org_eval',
  organizationMembershipId: 'om_eval',
  role: 'admin' as const,
  permissions: [],
  featureFlags: null,
}
const piloti: AgentPrincipal = { actor: 'piloti', session, clientId: null, scopes: [] }
const ctx = { principal: piloti, mode: 'search' as const }

/**
 * Queries a model writes for office work, each in both languages, then the
 * edge cases of the ranking. The German ones are what the people ask in; the
 * English ones what the catalog says.
 */
export const SEARCH_QUERIES = [
  'add member project',
  'Mitglied zu Projekt hinzufügen',
  'list project members',
  'Projektmitglieder anzeigen',
  'list projects',
  'Projekte auflisten',
  'create task',
  'Aufgabe erstellen',
  'inbox unread',
  'ungelesene Nachrichten im Eingang',
  'rename document',
  'Dokument umbenennen',
  'move document folder',
  'Datei in Ordner verschieben',
  'create folder',
  'Ordner anlegen',
  'document versions',
  'Fassungen eines Dokuments',
  'request review release',
  'Freigabe anfordern',
  'project memory',
  'Projektgedächtnis merken',
  'list proposals',
  'offene Vorschläge',
  'assign document responsible',
  'Verantwortlich zuweisen',
  'annotation reply',
  'Anmerkung beantworten',
  'conversation share',
  'Unterhaltung teilen',
  // The edges the mirror must keep: blank lists all, a one-letter word is dropped, no usable word finds nothing.
  '',
  'a project list',
  '(a+)+$',
] as const

interface Hit {
  name: string
}

function searchNames(query: string): string[] {
  const result = searchOperations(ctx, { query, limit: LIMIT })
  const operations = (result.structuredContent as { operations?: Hit[] } | undefined)?.operations ?? []
  return operations.map((op) => op.name)
}

function describeText(name: string): string {
  const result = describeOperation(ctx, { name })
  const first = result.content[0]
  return first && first.type === 'text' ? first.text : ''
}

function render(): string {
  const operations = visibleOperations(piloti).map((op) => {
    const annotations = annotationsOf(op)
    return {
      name: op.name,
      domain: op.domain,
      summary: op.summary,
      description: op.description,
      readOnly: annotations.readOnlyHint,
      destructive: annotations.destructiveHint,
      describe: describeText(op.name),
    }
  })
  const search = Object.fromEntries(SEARCH_QUERIES.map((query) => [query, searchNames(query)]))
  const fixture = {
    comment:
      'Written by src/app/api/mcp/workspace-eval.fixture.spec.ts from the real catalog; served by ' +
      'scripts/turn_census/fixture_workspace.py. Regenerate with UPDATE_FIXTURES=1.',
    limit: LIMIT,
    operations,
    search,
  }
  return `${JSON.stringify(fixture, null, 1)}\n`
}

describe('the workspace eval catalog', () => {
  it('is what the production door shows in-product Piloti', () => {
    const rendered = render()
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(FILE, rendered)
    expect(readFileSync(FILE, 'utf8')).toBe(rendered)
  })

  it('finds for a German request what the English one finds', () => {
    expect(searchNames('Mitglied zu Projekt hinzufügen')[0]).toBe('project-person-add')
    expect(searchNames('add member project')[0]).toBe('project-person-add')
  })

})
