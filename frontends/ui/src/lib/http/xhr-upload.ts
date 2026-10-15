/**
 * Upload a request body with real, byte-level progress.
 *
 * This is the one place in the app that reaches for `XMLHttpRequest` on
 * purpose. `fetch` cannot report REQUEST-upload progress — the browser exposes
 * no event for bytes leaving the machine, only for bytes arriving — so a
 * progress bar built on `fetch` has nothing truthful to show and has to invent
 * a number. Every "stuck at 15%" bar in a web app is that invention.
 *
 * Response bodies are returned as text and parsed by the caller: this module
 * knows about transport, not about anyone's payload schema.
 *
 * **A link that drops, or stops.** An architect on site uploads over a link
 * that comes and goes. A request whose bytes stop moving fails after
 * {@link DEFAULT_STALL_TIMEOUT_MS} without progress (not after a total time,
 * which an 80 MB drawing set on a slow link would exceed while healthy), and a
 * transport failure or a stall is sent again with backoff, after the browser
 * is back online, {@link DEFAULT_NETWORK_RETRIES} times. Only then does it
 * reject, with an {@link XhrNetworkError} the caller can offer a retry for. A
 * response with a status, a refusal included, is never sent again here: that
 * is the server's answer, and the caller's to read (a 429 waits out its
 * `Retry-After` there). A resend whose first copy did reach the server makes
 * no second document: the shelf files a document by its name and folder, so
 * the same file again is at worst a new Fassung of it, and `unchanged` once the
 * first has been read.
 */

import { applyJitter } from '@/shared/utils/backoff'

/** A non-2xx response. Carries the body so callers can lift the server's reason. */
export class XhrUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseText: string,
    /** Seconds the server asked the client to wait (`Retry-After`), when it said. */
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message)
    this.name = 'XhrUploadError'
  }
}

/** Why a request never got an answer. */
export type XhrNetworkFailure = 'network' | 'stalled' | 'timeout'

const NETWORK_MESSAGES: Record<XhrNetworkFailure, string> = {
  network: 'Upload failed: network error',
  stalled: 'Upload failed: the connection stalled',
  timeout: 'Upload failed: timed out',
}

/** No answer at all: the network failed, the transfer stalled, or the total timeout passed. Worth a retry. */
export class XhrNetworkError extends Error {
  readonly retryable = true
  constructor(readonly reason: XhrNetworkFailure) {
    super(NETWORK_MESSAGES[reason])
    this.name = 'XhrNetworkError'
  }
}

export interface XhrUploadOptions {
  url: string
  body: FormData | Blob | ArrayBuffer | string
  method?: string
  headers?: Record<string, string>
  /**
   * Bytes sent so far and the total the browser expects to send. `total`
   * includes multipart framing, so it is larger than the sum of the file
   * sizes — attribute payload bytes with that in mind. A resend starts again
   * from zero.
   */
  onProgress?: (loaded: number, total: number) => void
  /** Aborts the request; the promise rejects with an `AbortError` DOMException. */
  signal?: AbortSignal
  /** Milliseconds the whole request may take before it is abandoned, never resent. 0 (default) disables. */
  timeoutMs?: number
  /**
   * Milliseconds without a byte of progress, while bytes are still to go,
   * before the transfer counts as stalled. Default {@link DEFAULT_STALL_TIMEOUT_MS}; 0 disables.
   */
  stallTimeoutMs?: number
  /**
   * Once every byte is sent, how long the server may take to answer: it writes
   * the object, checks the quota and dispatches the ingest first. Default
   * {@link DEFAULT_RESPONSE_TIMEOUT_MS}; 0 disables.
   */
  responseTimeoutMs?: number
  /** Resends after a network failure or a stall. Default {@link DEFAULT_NETWORK_RETRIES}. */
  networkRetries?: number
  /** The wait before resend `attempt` (0-based). Default: 1 s doubling, with jitter. */
  retryDelayMs?: (attempt: number) => number
}

/** A link that moved nothing for this long is gone; a slow one still reports progress every second or so. */
export const DEFAULT_STALL_TIMEOUT_MS = 30_000
export const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000
export const DEFAULT_NETWORK_RETRIES = 3
/**
 * How long a resend waits for the browser to come back online before it is
 * tried anyway, and fails or works on its own. Long enough for a lift or a
 * tunnel, short enough that the row says so rather than "uploading" forever.
 */
export const OFFLINE_WAIT_MS = 5 * 60_000

const defaultRetryDelay = (attempt: number): number =>
  applyJitter(Math.min(8_000, 1_000 * 2 ** attempt))

/** Reject shape for an aborted upload — matches what `fetch` produces. */
const abortError = (): DOMException => new DOMException('Upload aborted', 'AbortError')

/**
 * POST `body` to `url`, resolving with the response text on 2xx.
 *
 * @throws {XhrUploadError} on a non-2xx response (with status + body)
 * @throws {DOMException} named `AbortError` when `signal` fires
 * @throws {XhrNetworkError} on a transport failure, a stall or the total timeout, once the resends are spent
 */
export async function xhrUpload(options: XhrUploadOptions): Promise<string> {
  const retries = options.networkRetries ?? DEFAULT_NETWORK_RETRIES
  const delayOf = options.retryDelayMs ?? defaultRetryDelay
  for (let attempt = 0; ; attempt++) {
    try {
      // The first send happens before this function's first await: the
      // request is open by the time the caller's next line runs.
      return await sendOnce(options)
    } catch (error) {
      const resendable = error instanceof XhrNetworkError && error.reason !== 'timeout'
      if (!resendable || attempt >= retries) throw error
      await waitToResend(delayOf(attempt), options.signal)
    }
  }
}

/** Wait out the backoff, then for the network if the browser says there is none. Rejects on abort. */
function waitToResend(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (settle: () => void) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
      settle()
    }
    const onAbort = () => finish(() => reject(abortError()))
    const onOnline = () => finish(resolve)
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      if (!offline || typeof window === 'undefined') return finish(resolve)
      window.addEventListener('online', onOnline)
      timer = setTimeout(() => finish(resolve), OFFLINE_WAIT_MS)
    }, ms)
  })
}

function sendOnce(options: XhrUploadOptions): Promise<string> {
  const {
    url,
    body,
    method = 'POST',
    headers,
    onProgress,
    signal,
    timeoutMs = 0,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  } = options

  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    const xhr = new XMLHttpRequest()
    xhr.open(method, url, true)

    for (const [name, value] of Object.entries(headers ?? {})) {
      xhr.setRequestHeader(name, value)
    }

    // Deliberately NOT set for FormData: the browser has to author the
    // `multipart/form-data` Content-Type itself so it can append the boundary.
    if (timeoutMs > 0) xhr.timeout = timeoutMs

    /** Set when this module aborted the request for a stall, so the abort is not the caller's. */
    let stalled = false
    let watch: ReturnType<typeof setTimeout> | null = null
    const unwatch = () => {
      if (watch) clearTimeout(watch)
      watch = null
    }
    /** Fail the request if nothing moves for `ms` from now. */
    const watchFor = (ms: number) => {
      unwatch()
      if (ms <= 0) return
      watch = setTimeout(() => {
        watch = null
        stalled = true
        xhr.abort()
      }, ms)
    }

    const onAbort = () => xhr.abort()
    signal?.addEventListener('abort', onAbort, { once: true })

    const settle = (finish: () => void) => {
      unwatch()
      signal?.removeEventListener('abort', onAbort)
      finish()
    }

    /** Every byte is on its way: what is left is the server's work, on its own clock. */
    const bodySent = () => watchFor(responseTimeoutMs)

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return watchFor(stallTimeoutMs)
      onProgress?.(event.loaded, event.total)
      if (event.loaded >= event.total) bodySent()
      else watchFor(stallTimeoutMs)
    })
    xhr.upload.addEventListener('load', bodySent)

    xhr.addEventListener('load', () => {
      settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText)
        } else {
          const retryAfter = Number(xhr.getResponseHeader('Retry-After'))
          reject(
            new XhrUploadError(
              `Upload failed with status ${xhr.status}`,
              xhr.status,
              xhr.responseText,
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null
            )
          )
        }
      })
    })

    xhr.addEventListener('error', () => {
      settle(() => reject(new XhrNetworkError('network')))
    })

    xhr.addEventListener('timeout', () => {
      settle(() => reject(new XhrNetworkError('timeout')))
    })

    xhr.addEventListener('abort', () => {
      settle(() => reject(stalled ? new XhrNetworkError('stalled') : abortError()))
    })

    xhr.send(body)
    watchFor(stallTimeoutMs)
  })
}
