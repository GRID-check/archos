/**
 * @vitest-environment node
 */
/**
 * The Beteiligte's typed client: the paths and verbs it sends, the answers it
 * parses, and how it reads a refusal.
 */
import { describe, expect, test, vi } from 'vitest'
import { createParticipantsClient, ParticipantsRequestError } from './participants-client'

const reply = (body: unknown, status = 200): Response => Response.json(body, { status })

describe('createParticipantsClient', () => {
  test('reads the roster with the reader’s own account', async () => {
    const fetch = vi.fn(async () =>
      reply({
        members: [{ organizationMembershipId: 'om-1', userId: 'u1', email: null, profilePictureUrl: null, name: 'A', role: null }],
        viewerUserId: 'u1',
      })
    )
    const roster = await createParticipantsClient(fetch).roster('p 1')
    expect(fetch).toHaveBeenCalledWith('/api/projects/p%201/members?scope=organization&limit=200', { method: 'GET' })
    expect(roster?.viewerUserId).toBe('u1')
  })

  test('a reader who may not manage the members gets no roster, and no error', async () => {
    const client = createParticipantsClient(async () => reply({ error: 'Forbidden', code: 'FORBIDDEN' }, 403))
    await expect(client.roster('p1')).resolves.toBeNull()
  })

  test('another failure is an error', async () => {
    const client = createParticipantsClient(async () => reply({ error: 'boom' }, 500))
    await expect(client.roster('p1')).rejects.toBeInstanceOf(ParticipantsRequestError)
  })

  test('names the last admin as the reason a role change was refused', async () => {
    const client = createParticipantsClient(async () => reply({ error: 'keep one', code: 'CONFLICT', details: { reason: 'last-admin' } }, 409))
    await expect(client.setRole('p1', 'om-1', '')).rejects.toMatchObject({ status: 409, reason: 'last-admin' })
  })

  test('adds a person with POST, describes one with PATCH, erases with DELETE', async () => {
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => (init?.method === 'DELETE' ? new Response(null, { status: 204 }) : reply({}, 201)))
    const client = createParticipantsClient(fetch)
    const person = { name: 'DI Maria Huber', function: 'Statik', company: null, startedOn: null, endedOn: null, userId: null }
    await client.savePerson('p1', person, null)
    await client.savePerson('p1', person, 'person-1')
    await client.removePerson('p1', 'person-1')
    expect(fetch.mock.calls.map(([path, init]) => [init?.method, path])).toEqual([
      ['POST', '/api/projects/p1/people'],
      ['PATCH', '/api/projects/p1/people/person-1'],
      ['DELETE', '/api/projects/p1/people/person-1'],
    ])
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(person)
  })

  test('parses the Steckbrief rather than casting it', async () => {
    const client = createParticipantsClient(async () => reply({ people: 'nobody' }))
    await expect(client.peopleRecord('p1')).rejects.toThrow()
  })
})
