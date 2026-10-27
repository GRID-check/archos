/**
 * @vitest-environment node
 */
/**
 * `GET /api/projects` answers one lean row per project unless `view=full` is
 * asked for: the profile of ten projects was ~46 KB, and every client reads
 * only id and name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeProject } from '@/test-utils/db-fixtures'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    role: 'member',
    permissions: [],
  }),
}))

const service = vi.hoisted(() => ({ listProjects: vi.fn(), createProject: vi.fn() }))
vi.mock('@/lib/projects/service', () => service)

import { GET } from './route'

const fact = (value: string) => ({ value, confidence: 'high', evidence: [] })
const kellermann = () =>
  makeProject({
    id: 'p1',
    name: 'Wohnhaus Kellermanngasse',
    profilePromptView: 'long prompt view '.repeat(100),
    profile: {
      facts: { project_name: fact('Haus Josef'), site_address: fact('Kellermanngasse 1, Wien') },
      goals: {},
      unknowns: [],
      assumptions: {},
    } as never,
  })

const get = (query = '') => GET(new Request(`https://grid.example/api/projects${query}`), { params: Promise.resolve({}) })

describe('GET /api/projects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    service.listProjects.mockResolvedValue([kellermann(), makeProject({ id: 'p2', name: 'Bürohaus Nord' })])
  })

  it('answers lean rows by default, with the name people use', async () => {
    const rows = await (await get()).json()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: 'p1',
      name: 'Wohnhaus Kellermanngasse',
      projectName: 'Haus Josef',
      siteAddress: 'Kellermanngasse 1, Wien',
      status: 'active',
    })
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['closedAt', 'createdAt', 'id', 'name', 'pausedAt', 'projectName', 'siteAddress', 'status'].sort()
    )
  })

  it('finds a project by its profile name', async () => {
    const rows = await (await get('?nameContains=josef')).json()
    expect(rows.map((row: { id: string }) => row.id)).toEqual(['p1'])
  })

  it('keeps the whole row behind view=full', async () => {
    const rows = await (await get('?view=full')).json()
    expect(rows[0]).toHaveProperty('profile')
    expect(rows[0]).toHaveProperty('profilePromptView')
  })

  it('refuses an unknown view', async () => {
    expect((await get('?view=everything')).status).toBe(400)
  })
})
