'use client'

import { useEffect, type JSX } from 'react'
import type { ExternalToast } from 'sonner'
import { LayerToaster } from '@/components/ui/sonner'

/** The review's own toaster, by the id its toasts name. */
export const REVIEW_TOASTER = 'document-review'

/** How many reviews have their toaster up (one, in practice). */
let mounted = 0

/**
 * The review's notices, at the foot of its canvas, `foot` pixels up: above the
 * viewer's pill and the chips of who is below, where the cursor chat stops too.
 * The app's corner is the review's header (the export, „Piloti prüfen lassen“)
 * and its list's filter, and a toast outside the review's modal dialog could
 * not be clicked: „Rückgängig“ lay over them for five seconds and did nothing.
 */
export function ReviewToaster({ foot }: { foot: number }): JSX.Element {
  useEffect(() => {
    mounted += 1
    return () => {
      mounted -= 1
    }
  }, [])
  return <LayerToaster id={REVIEW_TOASTER} foot={foot} />
}

/**
 * Where a review's toast goes: its own toaster while the review is open, the
 * app's once it has closed, so a write that fails after the review went (a
 * held decision is sent as it closes) is still said.
 */
export function reviewToast(options: ExternalToast = {}): ExternalToast {
  return mounted > 0 ? { ...options, toasterId: REVIEW_TOASTER } : options
}
