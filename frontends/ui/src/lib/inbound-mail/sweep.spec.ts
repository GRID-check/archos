/**
 * @vitest-environment node
 *
 * The sweeps' order and their isolation (`./sweep.ts`). What each sweep does
 * to the rows is proven against Postgres (`sweep.integration.spec.ts`); this
 * spec holds what no row shows: sweep 11 runs before the two that wait for the
 * audit trail, sweep 12 before the one that deletes the follows it ends, one
 * failing sweep costs no other its turn, and the caps' thresholds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const repository = vi.hoisted(() => {
  const empty = () => vi.fn(async () => [])
  return {
    findStaleReceptions: empty(),
    findReceivedWithoutJob: empty(),
    findLapsedClaims: empty(),
    findStalledMoves: empty(),
    findUnauditedDecisions: empty(),
    findExpiredMails: empty(),
    findExpiringMails: empty(),
    findEndedPartBytes: empty(),
    findMailsToSettle: empty(),
    findFailedScans: empty(),
    findReleasedErasures: empty(),
    findKeptMails: empty(),
    deleteKeptMails: empty(),
    findEndingFollows: empty(),
    findExpiringFollows: empty(),
    findOrphanedThreads: empty(),
    findAddressCapStates: empty(),
  }
})
vi.mock('./sweep-repository', () => repository)
vi.mock('@/lib/db/tenant-context', () => ({
  withPlatformAccess: async <T>(_reason: string, fn: () => T) => fn(),
  withTenant: async <T>(_scope: unknown, fn: () => T) => fn(),
}))
vi.mock('./announce', () => ({}))
vi.mock('./audit', () => ({ auditDecisions: vi.fn() }))
vi.mock('./filing-repository', () => ({ projectIsHeld: vi.fn() }))
vi.mock('./malware-scan', () => ({ scanForStorage: vi.fn() }))
vi.mock('./repository', () => ({ queueReceiveJob: vi.fn() }))
vi.mock('./staging', () => ({ eraseStagedObjects: vi.fn(), readStagedObject: vi.fn() }))
vi.mock('./receive', () => ({
  INBOUND_MAIL_ADDRESS_STAGED_BYTES: 1024 * 1024 * 1024,
  INBOUND_MAIL_ORGANIZATION_STAGED_BYTES: 5 * 1024 * 1024 * 1024,
}))
vi.mock('@/lib/mail-thread/originals', () => ({ finishOriginalMove: vi.fn() }))
vi.mock('@/lib/mail-thread/write-repository', () => ({ findEntryOfMail: vi.fn(), forgetMovedRaw: vi.fn() }))
vi.mock('@/lib/realtime/door-events', () => ({ publishProjectChanged: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn(), SYSTEM_ACTORS: { inboundMail: 'system:inbound_mail' } }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))

import { capNoticeFor, SWEEP_ORDER, sweepInboundMail } from './sweep'

const GIB = 1024 * 1024 * 1024

afterEach(() => {
  vi.clearAllMocks()
})

describe('the order the sweeps run in', () => {
  const at = (name: (typeof SWEEP_ORDER)[number]) => SWEEP_ORDER.indexOf(name)

  it('sends what is owed to the audit trail before the two sweeps that wait for it (RT-S8)', () => {
    expect(at('audits')).toBeLessThan(at('keptMails'))
    expect(at('audits')).toBeLessThan(at('threads'))
  })

  it('ends the follows (audited) before the sweep that deletes them with their thread', () => {
    expect(at('follows')).toBeLessThan(at('threads'))
  })

  it('runs every sweep of DECISION §5, and the caps, once', () => {
    expect(new Set(SWEEP_ORDER).size).toBe(14)
  })
})

describe('one sweep failing', () => {
  it('costs no other its turn, and is counted, not thrown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    repository.findExpiredMails.mockRejectedValueOnce(new Error('database gone'))

    const result = await sweepInboundMail(new Date())

    expect(result.expired).toEqual({ checked: 0, errors: 1 })
    expect(Object.keys(result)).toEqual([...SWEEP_ORDER])
    // The sweeps after it still ran.
    expect(repository.findKeptMails).toHaveBeenCalledTimes(1)
    expect(repository.findAddressCapStates).toHaveBeenCalledTimes(1)
    expect(result.keptMails).toEqual({ checked: 0, errors: 0, deleted: 0 })
  })
})

describe('the caps (D18)', () => {
  const state = (addressBytes: number, organizationBytes = addressBytes, revoked = false) => ({ addressBytes, organizationBytes, revoked })

  it('is nearly full at 80% of the address’s or the organization’s cap, and full at 100%', () => {
    expect(capNoticeFor(state(0.79 * GIB))).toBeNull()
    expect(capNoticeFor(state(0.8 * GIB))).toBe('nearly_full')
    expect(capNoticeFor(state(GIB))).toBe('full')
    expect(capNoticeFor(state(0, 4 * GIB))).toBe('nearly_full')
    expect(capNoticeFor(state(0, 5 * GIB))).toBe('full')
  })

  it('says nothing of a revoked address: its successor is a new row', () => {
    expect(capNoticeFor(state(GIB, GIB, true))).toBeNull()
  })
})
