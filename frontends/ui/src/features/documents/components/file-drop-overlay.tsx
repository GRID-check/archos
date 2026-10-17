'use client'

import { useEffect } from 'react'
import { Ban, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
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
  /** True when the dragged payload is a type the surface can't accept. */
  isUnsupported: boolean
  uploadLabel: string
  unsupportedLabel: string
  /** The surface cannot take files right now, and why (`useFileDragDrop`'s `refusal`). Wins over both labels. */
  refusal?: string | null
  testId: string
}

/**
 * The dashed full-surface overlay shown while a file is dragged over a
 * workspace. Identical across the Files and Archiv workspaces (they differ only
 * in the test id), so it lives here once. Callers gate rendering on their own
 * drag + permission state.
 */
export function FileDropOverlay({ isUnsupported, uploadLabel, unsupportedLabel, refusal, testId }: FileDropOverlayProps) {
  const refused = Boolean(refusal)
  const negative = refused || isUnsupported
  const Icon = refused ? Ban : Upload
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-2 z-50 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-center',
        negative ? 'border-destructive bg-destructive/5' : 'border-ring bg-primary/5 backdrop-blur-sm'
      )}
      data-testid={testId}
      data-refused={refused ? '' : undefined}
      role="status"
      aria-live="polite"
    >
      <Icon className={cn('size-6', negative ? 'text-destructive' : 'text-primary')} aria-hidden />
      <p className={cn('text-sm font-medium', negative ? 'text-destructive' : 'text-primary')}>
        {refusal ?? (isUnsupported ? unsupportedLabel : uploadLabel)}
      </p>
    </div>
  )
}
