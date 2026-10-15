import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { DEFAULT_STALL_TIMEOUT_MS, XhrNetworkError, xhrUpload, XhrUploadError } from './xhr-upload'
import { installFakeXhr, type FakeXhrHandle } from '@/test-utils/xhr-mock'

describe('xhrUpload', () => {
  let xhr: FakeXhrHandle

  beforeEach(() => {
    xhr = installFakeXhr()
  })

  afterEach(() => {
    xhr.restore()
  })

  const upload = (overrides: Partial<Parameters<typeof xhrUpload>[0]> = {}) =>
    xhrUpload({ url: '/api/documents/upload', body: new FormData(), ...overrides })

  test('resolves with the response text on 2xx', async () => {
    const pending = upload()
    xhr.last().respond(201, '{"documentId":"doc-1"}')
    await expect(pending).resolves.toBe('{"documentId":"doc-1"}')
  })

  test('reports upload progress only for computable events', async () => {
    const onProgress = vi.fn()
    const pending = upload({ onProgress })
    xhr.last().emitProgress(1_024, 4_096)
    xhr.last().respond(200, '{}')
    await pending

    expect(onProgress).toHaveBeenCalledExactlyOnceWith(1_024, 4_096)
  })

  test('a non-2xx carries the status and the body, so the caller can lift the reason', async () => {
    const pending = upload()
    xhr.last().respond(413, '{"error":"File too large"}')

    await expect(pending).rejects.toBeInstanceOf(XhrUploadError)
    await pending.catch((error: XhrUploadError) => {
      expect(error.status).toBe(413)
      expect(error.responseText).toBe('{"error":"File too large"}')
    })
  })

  test('a rate-limit refusal carries the server’s Retry-After', async () => {
    const pending = upload()
    xhr.last().respond(429, '{"error":"Too many requests"}', { 'retry-after': '7' })

    const error = (await pending.catch((e: unknown) => e)) as XhrUploadError
    expect(error.status).toBe(429)
    expect(error.retryAfterSeconds).toBe(7)
  })

  test('a network failure is distinguishable from a refusal', async () => {
    const pending = upload({ networkRetries: 0 })
    xhr.last().failNetwork()
    await expect(pending).rejects.toThrow('network error')
  })

  test('a timeout says so', async () => {
    const pending = upload({ timeoutMs: 5_000 })
    expect(xhr.last().timeout).toBe(5_000)
    xhr.last().timeOut()
    await expect(pending).rejects.toThrow('timed out')
  })

  test('an already-aborted signal never opens a request', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(upload({ signal: controller.signal })).rejects.toThrow(/aborted/i)
    expect(xhr.requests).toHaveLength(0)
  })

  test('aborting mid-flight stops the transfer and rejects with an AbortError', async () => {
    const controller = new AbortController()
    const pending = upload({ signal: controller.signal })
    controller.abort()

    expect(xhr.last().aborted).toBe(true)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('sets the caller headers but leaves Content-Type to the browser', async () => {
    const pending = upload({ headers: { Authorization: 'Bearer token' } })
    xhr.last().respond(200, '{}')
    await pending

    expect(xhr.last().headers).toEqual({ Authorization: 'Bearer token' })
  })
})

describe('xhrUpload over a link that drops or stops', () => {
  let xhr: FakeXhrHandle

  beforeEach(() => {
    vi.useFakeTimers()
    xhr = installFakeXhr()
  })

  afterEach(() => {
    xhr.restore()
    vi.useRealTimers()
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
  })

  const upload = (overrides: Partial<Parameters<typeof xhrUpload>[0]> = {}) =>
    xhrUpload({
      url: '/api/documents/upload',
      body: new FormData(),
      retryDelayMs: () => 1_000,
      ...overrides,
    })

  test('fails a transfer whose bytes stop moving, with an error worth a retry', async () => {
    const pending = upload({ networkRetries: 0 })
    const outcome = pending.catch((error: unknown) => error)
    xhr.last().emitProgress(1_024, 80_000_000)

    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_TIMEOUT_MS)

    expect(xhr.last().aborted).toBe(true)
    const error = await outcome
    expect(error).toBeInstanceOf(XhrNetworkError)
    expect(error).toMatchObject({ reason: 'stalled', retryable: true })
  })

  test('lets a slow transfer that keeps moving run as long as it takes', async () => {
    const pending = upload({ networkRetries: 0 })
    for (let step = 1; step <= 20; step += 1) {
      await vi.advanceTimersByTimeAsync(DEFAULT_STALL_TIMEOUT_MS - 1_000)
      xhr.last().emitProgress(step * 1_000, 80_000)
    }
    expect(xhr.last().aborted).toBe(false)
    xhr.last().respond(201, '{}')
    await expect(pending).resolves.toBe('{}')
  })

  test('once every byte is sent, waits for the server without a limit', async () => {
    const pending = upload({ networkRetries: 0 })
    xhr.last().emitProgress(4_096, 4_096)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(xhr.last().aborted).toBe(false)
    xhr.last().respond(201, '{}')
    await expect(pending).resolves.toBe('{}')
  })

  test('never sends a delivered file again: the server may already be filing it', async () => {
    const pending = upload()
    const outcome = pending.catch((error: unknown) => error)
    xhr.last().emitProgress(4_096, 4_096)
    xhr.last().failNetwork()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(xhr.requests).toHaveLength(1)
    expect(await outcome).toMatchObject({ reason: 'network', delivered: true, retryable: true })
  })

  test('a bounded answer wait fails delivered, and is not sent again', async () => {
    const pending = upload({ responseTimeoutMs: 120_000 })
    const outcome = pending.catch((error: unknown) => error)
    xhr.last().emitProgress(4_096, 4_096)

    await vi.advanceTimersByTimeAsync(120_000 + 60_000)
    expect(xhr.requests).toHaveLength(1)
    expect(await outcome).toMatchObject({ reason: 'stalled', delivered: true })
  })

  test('sends again after a network failure, with backoff, and resolves when one gets through', async () => {
    const pending = upload()
    xhr.last().failNetwork()
    await vi.advanceTimersByTimeAsync(999)
    expect(xhr.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(xhr.requests).toHaveLength(2)

    xhr.last().respond(201, '{"documentId":"doc-1"}')
    await expect(pending).resolves.toBe('{"documentId":"doc-1"}')
  })

  test('sends a stalled transfer again', async () => {
    const pending = upload()
    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_TIMEOUT_MS + 1_000)
    expect(xhr.requests).toHaveLength(2)
    xhr.last().respond(200, '{}')
    await expect(pending).resolves.toBe('{}')
  })

  test('gives up after its resends, with the network error', async () => {
    const pending = upload({ networkRetries: 2 })
    const outcome = pending.catch((error: unknown) => error)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      xhr.last().failNetwork()
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(xhr.requests).toHaveLength(3)
    expect(await outcome).toMatchObject({
      reason: 'network',
      message: 'Upload failed: network error',
    })
  })

  test('never sends a refusal again: that is the server answering', async () => {
    const pending = upload()
    xhr.last().respond(500, '{"error":"boom"}')
    await expect(pending).rejects.toBeInstanceOf(XhrUploadError)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(xhr.requests).toHaveLength(1)
  })

  test('waits for the browser to be back online before it sends again', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    const pending = upload()
    xhr.last().failNetwork()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(xhr.requests).toHaveLength(1)

    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(xhr.requests).toHaveLength(2)
    xhr.last().respond(200, '{}')
    await expect(pending).resolves.toBe('{}')
  })

  test('an abort while waiting to send again rejects with an AbortError and sends nothing', async () => {
    const controller = new AbortController()
    const pending = upload({ signal: controller.signal })
    const outcome = pending.catch((error: unknown) => error)
    xhr.last().failNetwork()
    controller.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(xhr.requests).toHaveLength(1)
  })
})
