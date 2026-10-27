'use client'

/**
 * Reader inputs, bound into the A2UI surface's data model (ADR-0143).
 *
 * A computing card's operands may be changed by the reader for a what-if. Where
 * that state lives is A2UI's standard answer: the surface's data model, at a
 * JSON-pointer path, written with `DataContext.set` and observed by
 * subscription — the same two-way binding A2UI's own input components use, and
 * the shape json-render's `$bindState` takes. The path is derived, never
 * authored: `/inputs/<leaf id>`, holding only the inputs the reader changed. The
 * model writes literal source values on the card; it never writes a path, so it
 * cannot bind a cited statement.
 *
 * Version-agnostic on purpose. The only A2UI surface this depends on is
 * `DataContext.set` and `DataModel.get`/`subscribe`, stable since v0.9; a card
 * drawn without A2UI (the fallback, a test) gets a local store with the same
 * interface, so the card has one code path.
 *
 * Nothing here leaves the browser. The data model is the surface's, in memory;
 * it is not `sendDataModel`'d anywhere, not stored on the message and gone on
 * reload, when the card shows its sources' values again.
 */

import { createContext, createElement, useContext, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { DataContext } from '@a2ui/web_core/v0_9'

/** What the reader changed, by input key. `null` is a field the reader cleared. */
export type ReaderOverrides = Readonly<Record<string, number | null>>

export interface ReaderInputStore {
  get(): ReaderOverrides | undefined
  set(next: ReaderOverrides | undefined): void
  subscribe(onChange: () => void): () => void
}

/** Where a leaf's reader inputs sit in its surface's data model. */
export const readerInputsPath = (leafId: string): string => `/inputs/${leafId.replace(/[~/]/g, '_')}`

/** A store over the surface's data model, at the leaf's derived path. */
export function dataModelStore(dataContext: DataContext, leafId: string): ReaderInputStore {
  const path = readerInputsPath(leafId)
  return {
    get: () => dataContext.dataModel.get(path) as ReaderOverrides | undefined,
    set: (next) => dataContext.set(path, next),
    subscribe: (onChange) => {
      const subscription = dataContext.dataModel.subscribe(path, () => onChange())
      return () => subscription.unsubscribe()
    },
  }
}

/** The same interface in component memory, for a card drawn without A2UI. */
export function localStore(): ReaderInputStore {
  let value: ReaderOverrides | undefined
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      value = next
      for (const listener of listeners) listener()
    },
    subscribe: (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
  }
}

const ReaderInputsContext = createContext<ReaderInputStore | null>(null)

/** Hands a leaf's data-model store to the card component A2UI draws there. */
export function ReaderInputsProvider({ store, children }: { store: ReaderInputStore; children: ReactNode }) {
  return createElement(ReaderInputsContext.Provider, { value: store }, children)
}

const NO_OVERRIDES: ReaderOverrides = Object.freeze({})

/**
 * The reader's overrides for this card, and the two writes there are: change
 * one input, or reset all of them to the source.
 */
export function useReaderOverrides(): {
  overrides: ReaderOverrides
  change: (key: string, value: number | null) => void
  reset: () => void
} {
  const bound = useContext(ReaderInputsContext)
  const [local] = useState(localStore)
  const store = bound ?? local
  const overrides = useSyncExternalStore(store.subscribe, store.get, store.get) ?? NO_OVERRIDES
  return {
    overrides,
    change: (key, value) => store.set({ ...(store.get() ?? {}), [key]: value }),
    reset: () => store.set(undefined),
  }
}
