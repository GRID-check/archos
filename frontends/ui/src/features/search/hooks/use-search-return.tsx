'use client'

import { createContext, useContext, useMemo, type JSX, type ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

import { searchReturnPath, type HitReturn } from '../lib/search-hrefs'

const SearchReturnContext = createContext<HitReturn>({})

/**
 * The search on screen as the address its hits return to (`back`,
 * `lib/search-hrefs.ts`). Provided by the search page and the shelves'
 * search; the ⌘K palette has none, since what lies under it is not a search.
 */
export function SearchReturnProvider({ children }: { children: ReactNode }): JSX.Element {
  const pathname = usePathname() ?? ''
  const query = useSearchParams()?.toString() ?? ''
  const value = useMemo<HitReturn>(() => ({ back: pathname ? searchReturnPath(pathname, query) : null }), [pathname, query])
  return <SearchReturnContext.Provider value={value}>{children}</SearchReturnContext.Provider>
}

/** Where a hit drawn here returns to on closing; nothing outside a search surface. */
export function useSearchReturn(): HitReturn {
  return useContext(SearchReturnContext)
}
