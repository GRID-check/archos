/**
 * Whether the code running now is a job slice (ADR-0079), not a request.
 *
 * A slice has no request: no cookies, no headers, no AuthKit session. Next
 * answers `cookies()` and `headers()` outside a request scope by throwing, so a
 * helper that reads the request (the locale, `i18n/server.ts`) asks this first
 * and answers as it would for a request that carried nothing. Over the HTTP door
 * the slice ran inside the runner's own POST, whose headers said nothing about
 * the person either, so the answer is the same through both doors.
 *
 * `AsyncLocalStorage.run` bounds the mark to the slice, as `acting-session.ts`
 * bounds an agent's call.
 */

import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'

const slice = new AsyncLocalStorage<true>()

/** Run `fn` as a job slice. Only `runJobSlice` (`./run.ts`) calls this. */
export function runAsJobSlice<T>(fn: () => Promise<T>): Promise<T> {
  return slice.run(true, fn)
}

/** True inside a job slice, where there is no request to read. */
export function inJobSlice(): boolean {
  return slice.getStore() === true
}
