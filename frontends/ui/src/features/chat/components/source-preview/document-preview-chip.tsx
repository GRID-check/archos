'use client'

import type { FC, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { HoverPeekPanel } from '@/components/ui/hover-peek-panel'
import type { SourceTint } from '@/lib/source-kinds'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import type { CitationRef } from '../../lib/citations'
import { useDelayedFlag } from '@/hooks/use-transient-flag'
import { thumbnailDocumentId } from '../CitationPageThumbnail'
import { CitationPeek } from '../CitationPeek'
import {
  CitationFace,
  faceClasses,
  faceStyle,
  type CitationDetail,
  type CitationVariant,
} from './citation-face'
import type { DocumentTarget } from './document-target'
import { useDocumentPreview } from './use-document-preview'

export const DocumentPreviewChip: FC<{
  target: DocumentTarget
  signal: SourceTint
  label: string
  authority?: string
  className?: string
  /** The marker(s) this source carries in the answer prose. */
  index?: string
  variant?: CitationVariant
  /** The reference this chip stands for — powers the dialog's "copy citation". */
  citation?: CitationRef
  trailing?: ReactNode
  detail?: CitationDetail
  /**
   * The document turned out to have no viewer after all — an office file whose
   * rendition the BFF could not make. The owner re-renders the chip as the
   * download it now is.
   */
  onUnrenderable?: () => void
}> = ({
  target,
  signal,
  label,
  authority,
  className,
  index,
  variant = 'chip',
  citation,
  trailing,
  detail,
  onUnrenderable,
}) => {
  const t = useTranslations('chat')
  const { isResolving, openPreview, dialog } = useDocumentPreview(target, citation)
  const peek = useHoverPopover()
  const showBusy = useDelayedFlag(isResolving)

  const open = (): void => {
    // Ignored, not refused, while the presign is in flight: a second click
    // must not race a second fetch (see `aria-busy` on the face below).
    if (isResolving) return
    // The dialog supersedes the peek — the peek's question is "what is this?",
    // and the document answers it far better than a panel floating over it.
    peek.dismiss()
    void openPreview().then((outcome) => {
      if (outcome === 'downloaded') onUnrenderable?.()
    })
  }

  const face = (
    <button
      type="button"
      className={cn(faceClasses(variant), className)}
      style={faceStyle(variant, signal)}
      {...peek.triggerProps}
      onClick={open}
      // BUSY, NOT DISABLED. `disabled` on the button the reader just pressed
      // dropped their keyboard focus to <body> (a disabled element cannot hold
      // it) and flashed the chip to 70% for a presign that usually answers in
      // under a tenth of a second. It stays focusable and pressable; `open`
      // ignores the press, and only a wait past the Doherty threshold
      // (`useDelayedFlag`) shows — as a spinner in the icon's own slot.
      aria-busy={isResolving || undefined}
      aria-haspopup="dialog"
      aria-label={t('sourcePreview.chipAria', { label })}
      // A native `title` only where there is no peek: with one, the browser's
      // tooltip arrived ~1s in and sat on top of the panel saying less.
      title={citation ? undefined : t('sourcePreview.chipAria', { label })}
    >
      <CitationFace
        variant={variant}
        signal={signal}
        label={label}
        authority={authority}
        index={index}
        citation={citation}
        trailing={trailing}
        detail={detail}
        busy={showBusy}
      />
    </button>
  )

  // The face is always the first child, and the peek is its sibling rather than
  // its wrapper — see `HoverPeekPanel` for why the button must never move.
  return (
    <>
      {face}
      {/* Hovering answers the question; clicking commits to the document. An
          openable source used to offer only the commitment, so checking one of
          eight chips meant opening and closing eight near-fullscreen dialogs.
          Without a reference there is nothing to preview, so the chip keeps its
          plain open-on-click behaviour rather than promising a peek it cannot
          fill. */}
      {citation && (
        <HoverPeekPanel peek={peek} className="w-80 p-3">
          <CitationPeek
            citation={citation}
            snippet={target.snippet}
            onOpen={open}
            supersededBy={target.supersededBy}
            thumbnailDocumentId={thumbnailDocumentId(target)}
          />
        </HoverPeekPanel>
      )}
      {dialog}
    </>
  )
}
