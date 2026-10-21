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
 * the fixture ranks with a Python mirror of the server's ranking, and
 * `tests/scripts/test_fixture_workspace.py` holds that mirror to these lists.
 * Two rankings are written: the one `discovery.ts` runs today (`production`),
 * and `lib/text/operation-search.ts` (`folded`), so the eval can measure both.
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
import { operationScorer } from '@/lib/text/operation-search'

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
const piloti: AgentPrincipal = { kind: 'piloti', session, clientId: null, scopes: [] }
const ctx = { principal: piloti, mode: 'discovery' as const }

/**
 * Queries a model writes for office work, each in both languages. The German
 * ones are what the people ask in; the English ones what the catalog says.
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
] as const

interface Hit {
  name: string
}

function productionNames(query: string): string[] {
  const result = searchOperations(ctx, { query, limit: LIMIT })
  const operations = (result.structuredContent as { operations?: Hit[] } | undefined)?.operations ?? []
  return operations.map((op) => op.name)
}

function foldedNames(query: string): string[] {
  const score = operationScorer(query)
  return visibleOperations(piloti)
    .map((op) => ({ name: op.name, score: score(op) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT)
    .map((hit) => hit.name)
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
  const search = {
    production: Object.fromEntries(SEARCH_QUERIES.map((query) => [query, productionNames(query)])),
    folded: Object.fromEntries(SEARCH_QUERIES.map((query) => [query, foldedNames(query)])),
  }
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

  it('finds the German request the English one finds, once the words are folded', () => {
    expect(productionNames('Mitglied zu Projekt hinzufügen')[0]).not.toBe('project-member-add')
    expect(foldedNames('Mitglied zu Projekt hinzufügen')[0]).toBe('project-member-add')
    expect(foldedNames('add member project')[0]).toBe(productionNames('add member project')[0])
  })
})
