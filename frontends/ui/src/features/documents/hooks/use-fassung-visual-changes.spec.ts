import { describe, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import { http, HttpResponse, type JsonBodyType } from 'msw'
import { renderHook, waitFor } from '@/test-utils'
import { server } from '@/mocks/server'
import { NO_VISIBLE_CHANGE } from '@/lib/documents/fassung-compare-types'
import { useFassungVisualChanges } from './use-fassung-visual-changes'

const NEWER = 'doc-newer'
const OLDER = '2f1c6e0e-4f0a-4c53-9a3e-0f2b7d8f6a11'
const REGION = { page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'Tür neu' }

interface Seen {
  id: string
  body: { older: string; page: number }
}

/** Answer the comparison route and record what it was asked. */
function answerWith(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = []
  server.use(
    http.post('/api/documents/:id/fassung-compare', async ({ request, params }) => {
      const entry = { id: String(params.id), body: (await request.json()) as Seen['body'] }
      seen.push(entry)
      return respond(entry)
    }),
  )
  return seen
}

const ok = (body: JsonBodyType) => HttpResponse.json(body)

describe('useFassungVisualChanges', () => {
  it('starts idle and asks nothing until it is told to', () => {
    const seen = answerWith(() => ok({}))

    const { result } = renderHook(() => useFassungVisualChanges(NEWER, OLDER))

    expect(result.current).toMatchObject({ state: 'idle', regions: [], summary: [], errorStatus: null })
    expect(seen).toEqual([])
  })

  it('runs for one page: loading, then the boxes and the words', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen = answerWith(async () => {
      await gate
      return ok({ regions: [REGION], summary: ['Eine Tür ist neu.'] })
    })
    const { result } = renderHook(() => useFassungVisualChanges(NEWER, OLDER))

    let settled: Promise<void> = Promise.resolve()
    act(() => {
      settled = result.current.run(2)
    })
    await waitFor(() => expect(result.current.state).toBe('loading'))
    release()
    await act(async () => settled)

    expect(result.current).toMatchObject({ state: 'done', regions: [REGION], summary: ['Eine Tür ist neu.'] })
    expect(seen).toEqual([{ id: NEWER, body: { older: OLDER, page: 2 } }])
  })

  it('says „keine sichtbare Änderung“ when the answer has neither a box nor a sentence', async () => {
    answerWith(() => ok({ regions: [], summary: [] }))
    const { result } = renderHook(() => useFassungVisualChanges(NEWER, OLDER))

    await act(async () => result.current.run(1))

    expect(result.current).toMatchObject({ state: 'done', regions: [], summary: [NO_VISIBLE_CHANGE] })
  })

  it('never draws a box that is not a box', async () => {
    answerWith(() => ok({ regions: [REGION, { ...REGION, x: 9 }, { ...REGION, label: '' }], summary: ['s'] }))
    const { result } = renderHook(() => useFassungVisualChanges(NEWER, OLDER))

    await act(async () => result.current.run(2))

    expect(result.current.regions).toEqual([REGION])
  })

  it.each([404, 409, 422, 502])('is an error with the status after a %i', async (status) => {
    answerWith(() => HttpResponse.json({ error: 'x' }, { status }))
    const { result } = renderHook(() => useFassungVisualChanges(NEWER, OLDER))

    await act(async () => result.current.run(1))

    expect(result.current).toMatchObject({ state: 'error', regions: [], summary: [], errorStatus: status })
  })

  it('is an error with status 0 when the request never arrives', async () => {
    answerWith(() => HttpResponse.error())
    const { result } = renderHook(() => useFassungVisualChanges(NEWER, OLDER))

    await act(async () => result.current.run(1))

    expect(result.current).toMatchObject({ state: 'error', errorStatus: 0 })
  })

  it('recovers from an error on the next run', async () => {
    let fail = true
    answerWith(() => (fail ? HttpResponse.json({}, { status: 502 }) : ok({ regions: [REGION], summary: ['s'] })))
    const { result } = renderHook(() => useFassungVisualChanges(NEWER, OLDER))

    await act(async () => result.current.run(2))
    expect(result.current.state).toBe('error')
    fail = false
    await act(async () => result.current.run(2))

    expect(result.current).toMatchObject({ state: 'done', errorStatus: null, regions: [REGION] })
  })

  it('answers a page it has already answered without asking again', async () => {
    const seen = answerWith(({ body }) => ok({ regions: [{ ...REGION, page: body.page }], summary: [`Seite ${body.page}`] }))
    const { result } = renderHook(() => useFassungVisualChanges(NEWER, OLDER))

    await act(async () => result.current.run(1))
    await act(async () => result.current.run(2))
    await act(async () => result.current.run(1))

    expect(seen.map((entry) => entry.body.page)).toEqual([1, 2])
    expect(result.current).toMatchObject({ state: 'done', summary: ['Seite 1'] })
  })

  it('drops the answer of an abandoned run: the page asked last wins', async () => {
    let releaseFirst: () => void = () => {}
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    answerWith(async ({ body }) => {
      if (body.page === 1) await first
      return ok({ regions: [], summary: [`Seite ${body.page}`] })
    })
    const { result } = renderHook(() => useFassungVisualChanges(NEWER, OLDER))

    let slow: Promise<void> = Promise.resolve()
    act(() => {
      slow = result.current.run(1)
    })
    await act(async () => result.current.run(2))
    releaseFirst()
    await act(async () => slow)

    expect(result.current).toMatchObject({ state: 'done', summary: ['Seite 2'] })
  })

  it('forgets everything when either document changes', async () => {
    const seen = answerWith(() => ok({ regions: [REGION], summary: ['s'] }))
    const { result, rerender } = renderHook(({ older }) => useFassungVisualChanges(NEWER, older), {
      initialProps: { older: OLDER },
    })
    await act(async () => result.current.run(2))
    expect(result.current.state).toBe('done')

    rerender({ older: 'another-older' })

    await waitFor(() => expect(result.current).toMatchObject({ state: 'idle', regions: [], summary: [] }))
    await act(async () => result.current.run(2))
    expect(seen.map((entry) => entry.body.older)).toEqual([OLDER, 'another-older'])
  })

  it.each([
    [null, OLDER],
    [NEWER, null],
    [undefined, undefined],
  ])('asks nothing without both documents (%s, %s)', async (newerId, olderId) => {
    const seen = answerWith(() => ok({}))
    const { result } = renderHook(() => useFassungVisualChanges(newerId, olderId))

    await act(async () => result.current.run(1))

    expect(seen).toEqual([])
    expect(result.current.state).toBe('idle')
  })
})
