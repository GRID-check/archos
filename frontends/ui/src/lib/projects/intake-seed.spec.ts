/**
 * @vitest-environment node
 *
 * What creating a project for Piloti writes beside it: the profile facts the
 * address decides, with the geocoder as evidence, and the intake row, in one
 * write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const seedProjectProfile = vi.fn()
vi.mock('@/lib/project-profile/profile-service', () => ({
  seedProjectProfile: (...args: unknown[]) => seedProjectProfile(...args),
}))
const insertProjectIntake = vi.fn()
vi.mock('@/lib/project-intake/repository', () => ({
  insertProjectIntake: (...args: unknown[]) => insertProjectIntake(...args),
}))
const inProjectTransaction = vi.fn()
vi.mock('./repository', () => ({
  inProjectTransaction: (...args: unknown[]) => inProjectTransaction(...args),
}))

import type { AuthorizedSession } from '@/lib/auth/types'
import type { GeocodeResult } from '@/lib/geocoding/types'
import { ProjectProfileSchema } from '@/lib/project-profile/types'
import { makeProject } from '@/test-utils/db-fixtures'
import { intakeRowFor, intakeSeedFacts, startProjectIntake } from './intake-seed'

const NOW = new Date('2026-10-14T09:00:00Z')
const session = { organizationId: 'org_1', userId: 'user_pl' } as AuthorizedSession

const location: GeocodeResult = {
  label: 'Innrain 1, 6020 Innsbruck',
  lat: 47.26,
  lon: 11.39,
  country: 'at',
  bundesland: 'tirol',
  state: 'Tirol',
  gemeinde: 'Innsbruck',
  postcode: '6020',
  kind: 'address',
}

describe('intakeSeedFacts', () => {
  it('turns a chosen address into address, country and Bundesland, the address with its geocoder evidence', () => {
    const facts = intakeSeedFacts({ location }, NOW)

    expect(Object.keys(facts).sort()).toEqual(['bundesland', 'country', 'standort_adresse'])
    expect(facts.standort_adresse).toEqual({
      value: 'Innrain 1, 6020 Innsbruck',
      confidence: 'confirmed',
      source: 'onboarding',
      updatedAt: NOW.toISOString(),
      evidence: [
        { kind: 'geocoder', provider: 'photon', label: 'Innrain 1, 6020 Innsbruck', resolvedAt: NOW.toISOString() },
      ],
    })
    expect(facts.country?.value).toBe('at')
    expect(facts.bundesland?.value).toBe('tirol')
    expect(ProjectProfileSchema.parse({ facts })).toBeTruthy()
  })

  it('leaves the Bundesland out when the provider named none we can match', () => {
    const facts = intakeSeedFacts({ location: { ...location, bundesland: null } }, NOW)
    expect(Object.keys(facts).sort()).toEqual(['country', 'standort_adresse'])
  })

  it('takes a Bundesland chosen by hand, without evidence', () => {
    const facts = intakeSeedFacts({ bundesland: 'salzburg' }, NOW)
    expect(Object.keys(facts).sort()).toEqual(['bundesland', 'country'])
    expect(facts.bundesland?.evidence).toBeUndefined()
  })

  it('is empty without an address or a Bundesland', () => {
    expect(intakeSeedFacts({}, NOW)).toEqual({})
  })
})

describe('intakeRowFor', () => {
  it('is waiting and active without a closing, with the description trimmed', () => {
    expect(intakeRowFor(session, 'p1', { description: '  Dachgeschoßausbau  ', location })).toEqual({
      organizationId: 'org_1',
      projectId: 'p1',
      createdBy: 'user_pl',
      mode: 'active',
      description: 'Dachgeschoßausbau',
      location,
      closing: null,
      status: 'waiting',
    })
  })

  it('is in closing mode exactly when it has a closing intent (the table CHECK)', () => {
    const closing = { outcome: 'completed' as const, startedOn: null, endedOn: '2022-08' as const }
    const row = intakeRowFor(session, 'p1', { closing })
    expect(row.mode).toBe('closing')
    expect(row.closing).toEqual(closing)
    expect(row.description).toBeNull()
    expect(row.location).toBeNull()
  })
})

describe('startProjectIntake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedProjectProfile.mockImplementation(
      async (_project: unknown, _profile: unknown, inTransaction?: (tx: unknown) => Promise<void>) => {
        await inTransaction?.('tx-profile')
      }
    )
    inProjectTransaction.mockImplementation(async (_org: string, work: (tx: unknown) => Promise<void>) =>
      work('tx-plain')
    )
    insertProjectIntake.mockResolvedValue(undefined)
  })

  it('writes the facts and the intake row in one transaction when there are facts', async () => {
    await startProjectIntake(session, makeProject({ id: 'p1', profile: { facts: {}, goals: {}, unknowns: [], assumptions: {} } }), { location, description: 'x' }, NOW)

    expect(seedProjectProfile).toHaveBeenCalledTimes(1)
    const [, profile] = seedProjectProfile.mock.calls[0] as [unknown, { facts: Record<string, { value: unknown }> }]
    expect(profile.facts.standort_adresse?.value).toBe('Innrain 1, 6020 Innsbruck')
    expect(insertProjectIntake).toHaveBeenCalledWith('tx-profile', expect.objectContaining({ projectId: 'p1', status: 'waiting' }))
    expect(inProjectTransaction).not.toHaveBeenCalled()
  })

  it('writes only the intake row when nothing is known about the place', async () => {
    await startProjectIntake(session, makeProject({ id: 'p1' }), { description: 'x' }, NOW)

    expect(seedProjectProfile).not.toHaveBeenCalled()
    expect(inProjectTransaction).toHaveBeenCalledWith('org_1', expect.any(Function))
    expect(insertProjectIntake).toHaveBeenCalledWith('tx-plain', expect.objectContaining({ projectId: 'p1' }))
  })

  it('lets a failed write through, so the caller rolls the project back', async () => {
    insertProjectIntake.mockRejectedValue(new Error('constraint'))
    await expect(startProjectIntake(session, makeProject({ id: 'p1' }), {}, NOW)).rejects.toThrow('constraint')
  })
})
