/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))
vi.mock('@/lib/turns/outcome', () => ({ recordTurnOutcome: vi.fn() }))

import { recordTurnOutcome } from '@/lib/turns/outcome'
import { POST } from './route'

const REAL_TOKEN = 'a-real-secret-token'
const TURN_ID = '11111111-1111-4111-8111-111111111111'

const makeRequest = (body: unknown, token?: string) =>
  new Request('https://grid.test/api/internal/turns/outcome', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-grid-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  })

const valid = { conversationId: 's_conv', turnId: TURN_ID, outcome: 'answered' }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/turns/outcome', () => {
  it('rejects a missing or wrong token before touching anything', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    expect((await POST(makeRequest(valid))).status).toBe(403)
    expect((await POST(makeRequest(valid, 'wrong'))).status).toBe(403)
    expect(recordTurnOutcome).not.toHaveBeenCalled()
  })

  it('fails closed when the token is unconfigured', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    expect((await POST(makeRequest(valid, REAL_TOKEN))).status).not.toBe(200)
    expect(recordTurnOutcome).not.toHaveBeenCalled()
  })

  it('records the outcome and answers whether it settled a wake', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(recordTurnOutcome).mockResolvedValue({ settled: true })
    const response = await POST(makeRequest({ ...valid, outcome: 'refused', reason: 'Budget erschöpft.' }, REAL_TOKEN))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ settled: true })
    expect(recordTurnOutcome).toHaveBeenCalledWith({ ...valid, outcome: 'refused', reason: 'Budget erschöpft.' })
  })

  it('is a 200 with settled false for an unknown turn', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(recordTurnOutcome).mockResolvedValue({ settled: false })
    const response = await POST(makeRequest(valid, REAL_TOKEN))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ settled: false })
  })

  it('rejects a body outside the contract', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    for (const body of [
      { ...valid, turnId: 'not-a-uuid' },
      { ...valid, outcome: 'done' },
      { ...valid, extra: true },
      { conversationId: 's_conv' },
    ]) {
      expect((await POST(makeRequest(body, REAL_TOKEN))).status).toBeGreaterThanOrEqual(400)
    }
    expect(recordTurnOutcome).not.toHaveBeenCalled()
  })
})
