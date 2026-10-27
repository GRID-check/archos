'use client'

import type { FC, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { HoverPeekPanel } from '@/components/ui/hover-peek-panel'
import type { SourceTint } from '@/features/layout/lib/source-presets'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import type { CitationRef } from '../../lib/citations'
import type { SourceKind } from '../../lib/source-kinds'
import { CitationPeek } from '../CitationPeek'
import {
  CitationFace,
  faceClasses,
  faceStyle,
  type CitationDetail,
  type CitationVariant,
} from './citation-face'
import type { DownloadTarget } from './document-target'
import { useCitationDownload } from './use-citation-download'
import { InfoPreviewChip } from './info-preview-chip'

/**
 * A cited document with no in-app viewer — offered as a file, with the reason.
 *
 * Same face as every other citation chip, because it is the same kind of thing:
 * the reader must not have to learn that a `.dwg` source is a different
 * species of chip. What differs is the one control the popover holds — a
 * download rather than an open — and the line above it saying why.
 */
export const DownloadPreviewChip: FC<{
  target: DownloadTarget
  signal: SourceTint
  label: string
  authority?: string
  className?: string
  /** The marker(s) this source carries in the answer prose. */
  index?: string
  variant?: CitationVariant
  /** The reference this chip stands for — powers the peek and "copy citation". */
  citation?: CitationRef
  trailing?: ReactNode
  detail?: CitationDetail
  kind: SourceKind
  /** Fine authority tier, for the fallback popover. */
  tier?: string
  bindingNote?: string
  meta?: string
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
  kind,
  tier,
  bindingNote,
  meta,
}) => {
  const t = useTranslations('chat')
  const { isDownloading, download } = useCitationDownload(target)
  const peek = useHoverPopover()

  // Without a reference there is no peek to fill, so the popover the info chip
  // already draws is the right one; it gains the download and the reason.
  if (!citation) {
    return (
      <InfoPreviewChip
        target={{ kind: 'info', title: target.title, snippet: target.snippet }}
        signal={signal}
        label={label}
        authority={authority}
        tier={tier}
        bindingNote={bindingNote}
        kind={kind}
        className={className}
        index={index}
        meta={meta}
        variant={variant}
        trailing={trailing}
        detail={detail}
        onDownload={() => void download()}
        downloadPending={isDownloading}
      />
    )
  }

  return (
    <>
      <button
        type="button"
        className={cn(faceClasses(variant), className)}
        style={faceStyle(variant, signal)}
        {...peek.triggerProps}
        aria-label={t('sourcePreview.chipAria', { label })}
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
        />
      </button>
      <HoverPeekPanel peek={peek} className="w-80 p-3">
        <CitationPeek
          citation={citation}
          snippet={target.snippet}
          onDownload={() => void download()}
          downloadPending={isDownloading}
          supersededBy={target.supersededBy}
        />
      </HoverPeekPanel>
    </>
  )
}
