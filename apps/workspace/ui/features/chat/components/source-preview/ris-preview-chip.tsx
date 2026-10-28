'use client'

import { useState, type FC, type ReactNode } from 'react'
import { Link2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { HoverPeekPanel } from '@/components/ui/hover-peek-panel'
import type { SourceTint } from '@/lib/source-kinds'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import type { CitationRef } from '../../lib/citations'
import { RisDocumentDialog } from '@/features/knowledge/components/ris-document-dialog'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import { CitationPeek } from '../CitationPeek'
import { CopySourceCitationButton } from '../CopyCitation'
import { CopyCitationLinkButton } from '../CopyCitationLink'
import {
  CitationFace,
  faceClasses,
  faceStyle,
  type CitationDetail,
  type CitationVariant,
} from './citation-face'
import type { RisTarget } from './document-target'

/**
 * A RIS source, read inside Piloti.
 *
 * Behaves like the document chip and not like the web link it used to be:
 * hovering answers "what is this?", clicking commits to the document. The
 * outbound link is not lost — it moves into the dialog's header, where it is
 * the authoritative publication rather than the only way in.
 */
export const RisPreviewChip: FC<{
  target: RisTarget
  signal: SourceTint
  label: string
  authority?: string
  className?: string
  index?: string
  variant?: CitationVariant
  citation?: CitationRef
  trailing?: ReactNode
  detail?: CitationDetail
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
}) => {
  const t = useTranslations(chatCopy)
  const [isOpen, setIsOpen] = useState(false)
  const peek = useHoverPopover()

  const open = (): void => {
    peek.dismiss()
    setIsOpen(true)
  }

  const dialog = (
    <RisDocumentDialog
      open={isOpen}
      onOpenChange={setIsOpen}
      url={target.url}
      title={target.title}
      highlight={target.snippet}
      highlightColor={`var(--source-${signal})`}
      headerChip={
        <SourceSignalChip signal={signal}>{t('sourcePreview.risDocument')}</SourceSignalChip>
      }
      headerActions={
        citation && (
          <span className="flex shrink-0 items-center gap-2">
            <CopyCitationLinkButton citation={citation} icon={<Link2 className="size-3" />} />
            <CopySourceCitationButton citation={citation} />
          </span>
        )
      }
    />
  )

  const face = (
    <button
      type="button"
      className={cn(faceClasses(variant), className)}
      style={faceStyle(variant, signal)}
      {...peek.triggerProps}
      onClick={open}
      aria-haspopup="dialog"
      aria-label={t('sourcePreview.chipAria', { label })}
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
      />
    </button>
  )

  return (
    <>
      {face}
      {citation && (
        <HoverPeekPanel peek={peek} className="w-80 p-3">
          <CitationPeek
            citation={citation}
            snippet={target.snippet}
            onOpen={open}
            url={target.url}
          />
        </HoverPeekPanel>
      )}
      {dialog}
    </>
  )
}
