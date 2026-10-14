'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Which control of a page started the request in flight. The page's `busy`
 * flag says a call is running and every control waits; this says which one
 * was pressed, so only that one takes the busy label and the rest merely wait.
 * `press` runs the work and clears itself, also when the control leaves the
 * page with the answer (a confirmed row is gone by the time the call returns).
 */
export function usePressed(): [boolean, (work: () => Promise<unknown>) => void] {
  const [pressed, setPressed] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const press = useCallback((work: () => Promise<unknown>): void => {
    setPressed(true)
    void work().finally(() => {
      if (mounted.current) setPressed(false)
    })
  }, [])

  return [pressed, press]
}
