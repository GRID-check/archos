'use client'

import type { FC, ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { HoverPeekPanel } from '@/components/ui/hover-peek-panel'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import type { CitationRef } from '../../lib/citations'
import { SectionLabel } from '@/components/ui/section-label'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import type { SourceKind, SourceTint } from '@/lib/source-kinds'
import { PEEK_ACTION_CLASSES, PeekDownloadButton } from '../CitationPeek'
import { CopySourceCitationButton } from '../CopyCitation'
import {
  CitationFace,
  faceClasses,
  faceStyle,
  type CitationDetail,
  type CitationVariant,
} from './citation-face'
import type { InfoTarget } from './document-target'
import { CitedPassageBox } from './cited-passage-box'

// ---------------------------------------------------------------------------
// Info popover (title + origin + snippet — no resolvable document)
// ---------------------------------------------------------------------------


export const InfoPreviewChip: FC<{
  target: InfoTarget
  signal: SourceTint
  label: string
  authority?: string
  /** Fine authority tier ("OIB-Richtlinie", "Rechtsquelle (RIS)") for the popover. */
  tier?: string
  /** Bindingness note ("does this bind me?") from the norm registry. */
  bindingNote?: string
  /**
   * Canonical coarse kind (ADR-0026) — the popover's provenance line. It is the
   * document's kind, never the kb/ris/web origin token: a knowledge-base copy
   * of a legal text used to read "Project knowledge" here while the chip beside
   * it showed a RIS badge and a Baurecht lane — the same source, contradicted.
   */
  kind: SourceKind
  /** A precedent from another project (ADR-0094): its kind line says „Präzedenzfall“, not the coarse kind's label. */
  precedent?: boolean
  /** Outbound link (RIS sources) shown as an "open" button inside the popover. */
  url?: string
  className?: string
  /** The marker(s) this source carries in the answer prose. */
  index?: string
  /** Cited page / hostname — shown in the popover, not on the chip. */
  meta?: string
  variant?: CitationVariant
  /** The reference this chip stands for, for the popover's "copy citation". */
  citation?: CitationRef
  trailing?: ReactNode
  detail?: CitationDetail
  /**
   * The document exists but has no in-app viewer — hand it over instead.
   * Set only by {@link DownloadPreviewChip}; a genuinely unresolvable source
   * leaves it unset and keeps saying nothing can be opened.
   */
  onDownload?: () => void
  downloadPending?: boolean
}> = ({
  target,
  signal,
  label,
  authority,
  tier,
  bindingNote,
  url,
  className,
  index,
  meta,
  variant = 'chip',
  citation,
  trailing,
  kind,
  precedent,
  detail,
  onDownload,
  downloadPending,
}) => {
  const t = useTranslations(chatCopy)
  const peek = useHoverPopover()
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
      <HoverPeekPanel peek={peek} className="w-80 space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceSignalChip signal={signal}>
            {t(precedent ? 'sourcePreview.kinds.praezedenz' : `sourcePreview.kinds.${kind}`)}
          </SourceSignalChip>
          {tier && <span className="text-muted-foreground text-xs font-medium">{tier}</span>}
        </div>
        {/* The written source list's payload, one click away: the citation
            number, the untruncated title and the locator. */}
        <p className="text-foreground break-words text-sm font-medium">
          {index && <span className="text-muted-foreground mr-1">[{index}]</span>}
          {target.title}
        </p>
        {meta && <p className="text-muted-foreground text-xs">{meta}</p>}
        {bindingNote && (
          <div
            className="rounded-control px-2.5 py-1.5"
            style={{
                backgroundColor: `var(--source-${signal}-tint, var(--muted))`,
            }}
          >
            <SectionLabel
              as="p"
              style={{ color: `var(--source-${signal}-text, var(--muted-foreground))` }}
            >
              {t('sourcePreview.bindingLabel')}
            </SectionLabel>
            <p className="text-foreground mt-0.5 text-xs leading-relaxed">{bindingNote}</p>
          </div>
        )}
        {target.snippet && <CitedPassageBox snippet={target.snippet} signal={signal} />}
        {/* Why there is no viewer, before the control that works around it. */}
        {onDownload && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t('citationPeek.noInlineViewer')}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          {onDownload ? (
            <PeekDownloadButton tint={signal} onDownload={onDownload} pending={downloadPending} />
          ) : url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={PEEK_ACTION_CLASSES}
              style={{ color: `var(--source-${signal}-text, var(--foreground))` }}
            >
              {t('sourcePreview.openExternal')}
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          ) : (
            <span />
          )}
          {citation && <CopySourceCitationButton citation={citation} />}
        </div>
      </HoverPeekPanel>
    </>
  )
}
