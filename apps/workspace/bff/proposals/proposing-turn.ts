/**
 * The turn that proposed what is being applied now: the answer message a
 * proposal was filed from (`origin_message_id`), carried out of band to the
 * route a proposal's operation runs (`operation-applier.ts` → the route →
 * its service), so a score of the apply lands on the trace of the turn that
 * proposed it rather than on an older one. Set only by the applier, in
 * process: no request can claim it.
 */

import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<{ messageId: string | null }>()

/** Run `fn` as the apply of a proposal filed from `messageId`. */
export function withProposingTurn<T>(messageId: string | null, fn: () => Promise<T>): Promise<T> {
  return storage.run({ messageId }, fn)
}

/** The answer message of the proposal being applied, or null outside an apply. */
export function proposingTurn(): string | null {
  return storage.getStore()?.messageId ?? null
}
