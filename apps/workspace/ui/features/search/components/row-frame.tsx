'use client'

import type { ComponentType, ReactNode } from 'react'
import { createContext, useContext } from 'react'

/**
 * How a hit's row sits in something other than the result list: the ⌘K
 * palette hands its own option (a cmdk item) here, so the palette and the page
 * draw one hit with the same parts, in the same order, from the same row
 * components. Absent, the row is the list's link.
 */
export interface ResultRowFrameProps {
  href: string
  testId?: string
  /** The row's layout, for the frame's own box. */
  className: string
  children: ReactNode
}
export const ResultRowFrameContext = createContext<ComponentType<ResultRowFrameProps> | null>(null)
export const ResultRowFrameProvider = ResultRowFrameContext.Provider

/**
 * Whether the row stands in the ⌘K palette (a frame is provided) rather than
 * the result list: there it is compact, every part held to one line.
 */
export function useCompactRow(): boolean {
  return useContext(ResultRowFrameContext) !== null
}
