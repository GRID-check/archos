/**
 * @vitest-environment node
 *
 * „An dieser Adresse gibt es schon ein Projekt": the same line, or the same
 * plot within 50 m, bounded to three, and only what the person may open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const listProjectAddressesInOrg = vi.fn()
vi.mock('./repository', () => ({
  listProjectAddressesInOrg: (...args: unknown[]) => listProjectAddressesInOrg(...args),
}))
const projectsHolding = vi.fn()
vi.mock('./service', () => ({ projectsHolding: (...args: unknown[]) => projectsHolding(...args) }))

import type { AuthorizedSession } from '@/lib/auth/types'
import type { GeocodeResult } from '@/lib/geocoding/types'
import type { ProjectAddressRow } from './repository'
import { findProjectsAtAddress, matchSameAddress } from './same-address'

const session = { organizationId: 'org_1' } as AuthorizedSession

const hit = (lat: number, lon: number): GeocodeResult => ({
  label: 'x',
  lat,
  lon,
  country: 'at',
  federalState: 'vienna',
  state: 'Wien',
  municipality: 'Wien',
  postcode: null,
  kind: 'address',
})

const row = (id: string, over: Partial<ProjectAddressRow> = {}): ProjectAddressRow => ({
  id,
  name: `Projekt ${id}`,
  status: 'active',
  address: null,
  location: null,
  ...over,
})

describe('matchSameAddress', () => {
  const rows = [
    row('same-line', { address: 'hauptstrasse 12,  1010 WIEN' }),
    row('other-number', { address: 'Hauptstraße 21, 1010 Wien' }),
    row('near', { location: hit(48.2001, 16.3701) }),
    row('far', { location: hit(48.21, 16.38) }),
    row('nothing'),
  ]

  it('matches the same address line, folded, and a location within 50 m, the line first', () => {
    const matches = matchSameAddress(rows, { label: 'Hauptstraße 12, 1010 Wien', lat: 48.2, lon: 16.37 })
    expect(matches.map((match) => match.id)).toEqual(['same-line', 'near'])
  })

  it('matches by line alone when the point is not given', () => {
    const matches = matchSameAddress(rows, { label: 'Hauptstraße 12, 1010 Wien' })
    expect(matches.map((match) => match.id)).toEqual(['same-line'])
  })

  it('matches nothing for a label with no letters', () => {
    expect(matchSameAddress([row('p', { address: '' })], { label: ' , ' })).toEqual([])
  })
})

describe('findProjectsAtAddress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    projectsHolding.mockImplementation(async (_session: unknown, projects: unknown[]) => projects)
  })

  it('asks access only about the matches, and answers id, name and status', async () => {
    listProjectAddressesInOrg.mockResolvedValue([
      row('a', { address: 'Hauptstraße 12, 1010 Wien', status: 'closed' }),
      row('b', { address: 'Andere Gasse 1, 1020 Wien' }),
    ])

    const found = await findProjectsAtAddress(session, { label: 'Hauptstraße 12, 1010 Wien' })

    expect(found).toEqual([{ id: 'a', name: 'Projekt a', status: 'closed' }])
    expect(projectsHolding).toHaveBeenCalledWith(session, [expect.objectContaining({ id: 'a' })])
  })

  it('leaves out what the person may not open', async () => {
    listProjectAddressesInOrg.mockResolvedValue([
      row('a', { address: 'Hauptstraße 12, 1010 Wien' }),
      row('secret', { address: 'Hauptstraße 12, 1010 Wien' }),
    ])
    projectsHolding.mockImplementation(async (_s: unknown, projects: Array<{ id: string }>) =>
      projects.filter((project) => project.id !== 'secret')
    )

    const found = await findProjectsAtAddress(session, { label: 'Hauptstraße 12, 1010 Wien' })
    expect(found.map((project) => project.id)).toEqual(['a'])
  })

  it('shows at most three', async () => {
    listProjectAddressesInOrg.mockResolvedValue(
      ['a', 'b', 'c', 'd', 'e'].map((id) => row(id, { address: 'Hauptstraße 12, 1010 Wien' }))
    )
    const found = await findProjectsAtAddress(session, { label: 'Hauptstraße 12, 1010 Wien' })
    expect(found).toHaveLength(3)
  })

  it('does not ask access when nothing matched', async () => {
    listProjectAddressesInOrg.mockResolvedValue([row('a', { address: 'Andere Gasse 1' })])
    expect(await findProjectsAtAddress(session, { label: 'Hauptstraße 12, 1010 Wien' })).toEqual([])
    expect(projectsHolding).not.toHaveBeenCalled()
  })
})
