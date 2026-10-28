'use client'

import type { CSSProperties, FC } from 'react'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { SectionLabel } from '@/components/ui/section-label'
import type { SourceTint } from '@/lib/source-kinds'

/** Tinted "Fundstelle" / cited-passage box shown above the document frame. */
export const CitedPassageBox: FC<{ snippet: string; signal: SourceTint }> = ({ snippet, signal }) => {
  const t = useTranslations(chatCopy)
  const style: CSSProperties = {
    backgroundColor: `var(--source-${signal}-tint, var(--muted))`,
    borderColor: `color-mix(in oklch, var(--source-${signal}, var(--foreground)) 25%, transparent)`,
  }
  return (
    <div className="shrink-0 rounded-lg border px-3 py-2" style={style}>
      <SectionLabel
        as="p"
        style={{ color: `var(--source-${signal}-text, var(--muted-foreground))` }}
      >
        {t('sourcePreview.citedPassage')}
      </SectionLabel>
      <p className="text-foreground mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-sm">
        {snippet}
      </p>
    </div>
  )
}
