'use client'

import { useEffect, type ReactNode } from 'react'
import { Ban, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion, motionQuick, motionSnap, useMotionToken } from '@/components/motion'
import { isExternalFileDrag } from '../hooks/use-document-drag'

/**
 * Keep a FILE dropped outside every drop target from replacing the app: the
 * browser's own answer to a released file is to open it in the tab.
 *
 * Files only. It used to cancel every `dragover` and `drop` on the window, and
 * cancelling `dragover` is what tells the browser „a drop is welcome here", so
 * every drag showed the copy cursor over every pixel: a document released
 * between two folder tiles looked accepted and did nothing, and text or a link
 * dragged into the chat field was never inserted, because cancelling `drop`
 * cancels the browser's insert. Zones claim the drags they take and stop them,
 * so what reaches the window is a file drag nobody took: it gets „no drop".
 */
export function useWindowDragGuard(): void {
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!isExternalFileDrag(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    const drop = (e: DragEvent) => {
      if (isExternalFileDrag(e.dataTransfer)) e.preventDefault()
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])
}

interface FileDropOverlayProps {
  /** Whether a file is being dragged over the surface (and it may take one). */
  show: boolean
  /** True when the dragged payload is a type the surface can't accept. */
  isUnsupported: boolean
  uploadLabel: string
  unsupportedLabel: string
  /** The surface cannot take files right now, and why (`useFileDragDrop`'s `refusal`). Wins over both labels. */
  refusal?: string | null
  /** A quieter line under the label: where the files go, or what is accepted. Not shown with a refusal. */
  hint?: ReactNode
  testId: string
}

/**
 * The dashed full-surface overlay shown while a file is dragged over a
 * workspace. Identical across the Files and Archiv workspaces (they differ only
 * in the test id), so it lives here once. Callers pass their own drag +
 * permission state as `show`; the overlay owns its presence so it can leave.
 *
 * It fades, in on `motionQuick` and out one step shorter. Popped in and out,
 * the blurred veil flashed over the whole surface every time a drag crossed
 * its edge, which a reader dragging past the chat on the way to a folder saw
 * twice per drag. Opacity only, on the veil itself, so its `backdrop-blur` fades with it.
 * Under reduced motion both are instant (`useMotionToken`).
 */
export function FileDropOverlay({
  show,
  isUnsupported,
  uploadLabel,
  unsupportedLabel,
  refusal,
  hint,
  testId,
}: FileDropOverlayProps) {
  const enter = useMotionToken(motionQuick)
  const exit = useMotionToken(motionSnap)
  const refused = Boolean(refusal)
  const negative = refused || isUnsupported
  const Icon = refused ? Ban : Upload
  return (
    <AnimatePresence initial={false}>
      {show && (
        // The fade sits on the element that carries the blur: an ancestor
        // below full opacity is a backdrop root, which would blur nothing
        // during the fade and then snap the blur on at its end.
        <motion.div
          key="file-drop-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: enter }}
          exit={{ opacity: 0, transition: exit }}
          className={cn(
            'pointer-events-none absolute inset-2 z-50 flex flex-col items-center justify-center gap-2 rounded-control border-2 border-dashed text-center',
            negative ? 'border-destructive bg-destructive/5' : 'border-ring bg-primary/5 backdrop-blur-sm'
          )}
          data-testid={testId}
          data-refused={refused ? '' : undefined}
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-col items-center gap-2 px-4">
            <Icon className={cn('size-6', negative ? 'text-destructive' : 'text-primary')} aria-hidden />
            <p className={cn('text-sm font-medium', negative ? 'text-destructive' : 'text-primary')}>
              {refusal ?? (isUnsupported ? unsupportedLabel : uploadLabel)}
            </p>
            {!refused && hint}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
