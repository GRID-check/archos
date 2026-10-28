/**
 * The review kept current: polling while Piloti reads, the answer of a decision
 * replacing the view, and what a refused or failed call says.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { INTAKE_READING, INTAKE_READY, INTAKE_WAITING } from '@/app/dev/_fixtures/project-intake'
import type { ProjectIntakeClient } from '@/lib/project-intake/client'
import { INTAKE_POLL_MS, INTAKE_WATCH_MS, useIntake } from './use-intake'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const client = {
  get: vi.fn<ProjectIntakeClient['get']>(),
  start: vi.fn<ProjectIntakeClient['start']>(),
  decide: vi.fn<ProjectIntakeClient['decide']>(),
  complete: vi.fn<ProjectIntakeClient['complete']>(),
}
const ID = INTAKE_READY.projectId

const mount = (initial = INTAKE_READY) => renderHook(() => useIntake({ projectId: ID, initial, client }))

describe('useIntake', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => vi.useRealTimers())

  it('does not poll a review nobody is reading', async () => {
    mount(INTAKE_READY)
    await act(() => vi.advanceTimersByTimeAsync(INTAKE_POLL_MS * 3))
    expect(client.get).not.toHaveBeenCalled()
  })

  it('polls every five seconds while Piloti reads, and stops when the reading ends', async () => {
    client.get.mockResolvedValueOnce(INTAKE_READING).mockResolvedValue(INTAKE_READY)
    const { result } = mount(INTAKE_READING)

    await act(() => vi.advanceTimersByTimeAsync(INTAKE_POLL_MS - 1))
    expect(client.get).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(client.get).toHaveBeenCalledTimes(1)
    expect(client.get).toHaveBeenCalledWith(ID)

    await act(() => vi.advanceTimersByTimeAsync(INTAKE_POLL_MS))
    expect(client.get).toHaveBeenCalledTimes(2)
    expect(result.current.view.status).toBe('ready')

    await act(() => vi.advanceTimersByTimeAsync(INTAKE_POLL_MS * 4))
    expect(client.get).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good view and says it is stale when a poll fails', async () => {
    client.get.mockRejectedValue(new Error('offline'))
    const { result } = mount(INTAKE_READING)

    await act(() => vi.advanceTimersByTimeAsync(INTAKE_POLL_MS))

    expect(result.current.view).toBe(INTAKE_READING)
    expect(result.current.stale).toBe(true)

    client.get.mockResolvedValue(INTAKE_READY)
    await act(() => vi.advanceTimersByTimeAsync(INTAKE_POLL_MS))
    expect(result.current.stale).toBe(false)
  })

  it('watches for a while after documents were handed in, then stops', async () => {
    client.get.mockResolvedValue(INTAKE_WAITING)
    const { result } = mount(INTAKE_WAITING)

    act(() => result.current.watch())
    await act(() => vi.advanceTimersByTimeAsync(INTAKE_POLL_MS))
    expect(client.get).toHaveBeenCalledTimes(1)

    await act(() => vi.advanceTimersByTimeAsync(INTAKE_WATCH_MS + INTAKE_POLL_MS * 2))
    const calls = client.get.mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(INTAKE_POLL_MS * 5))
    expect(client.get).toHaveBeenCalledTimes(calls)
  })

  it('replaces the view with the review a decision answers with', async () => {
    client.decide.mockResolvedValue({ results: [{ key: 'oib_edition', ok: true }], intake: INTAKE_WAITING })
    const { result } = mount()

    let ok = false
    await act(async () => {
      ok = await result.current.decide([{ key: 'oib_edition', action: 'confirm' }])
    })

    expect(ok).toBe(true)
    expect(client.decide).toHaveBeenCalledWith(ID, [{ key: 'oib_edition', action: 'confirm' }])
    expect(result.current.view).toBe(INTAKE_WAITING)
    expect(toast.error).not.toHaveBeenCalled()
    expect(result.current.busy).toBe(false)
  })

  it('says how many decisions were not taken, and still shows the review after them', async () => {
    client.decide.mockResolvedValue({
      results: [
        { key: 'a', ok: true },
        { key: 'b', ok: false, reason: 'dismissed' },
        { key: 'c', ok: false },
      ],
      intake: INTAKE_WAITING,
    })
    const { result } = mount()

    let ok = true
    await act(async () => {
      ok = await result.current.decide([{ key: 'a', action: 'confirm' }])
    })

    expect(ok).toBe(false)
    expect(result.current.view).toBe(INTAKE_WAITING)
    expect(toast.error).toHaveBeenCalledWith('2 decisions were not taken.')
  })

  it('says a failed call failed, and leaves the view alone', async () => {
    client.decide.mockRejectedValue(new Error('500'))
    const { result } = mount()

    let ok = true
    await act(async () => {
      ok = await result.current.decide([{ key: 'a', action: 'unknown' }])
    })

    expect(ok).toBe(false)
    expect(result.current.view).toBe(INTAKE_READY)
    expect(toast.error).toHaveBeenCalledWith('That did not work. Please try again.')
    expect(result.current.busy).toBe(false)
  })

  it('starts a reading of what is new and shows the review it answers with', async () => {
    client.start.mockResolvedValue(INTAKE_READING)
    const { result } = mount()

    await act(async () => result.current.reread())

    expect(client.start).toHaveBeenCalledWith(ID, { scope: 'new' })
    expect(result.current.view).toBe(INTAKE_READING)
  })

  it('completes the review and shows it finished', async () => {
    client.complete.mockResolvedValue({ ...INTAKE_READY, status: 'completed' })
    const { result } = mount()

    let ok = false
    await act(async () => {
      ok = await result.current.complete()
    })

    expect(ok).toBe(true)
    expect(result.current.view.status).toBe('completed')
  })

  it('says so when the review could not be finished', async () => {
    client.complete.mockRejectedValue(new Error('403'))
    const { result } = mount()

    let ok = true
    await act(async () => {
      ok = await result.current.complete()
    })

    expect(ok).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('We could not finish the setup.')
  })
})
