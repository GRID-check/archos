'use client'

import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import type { RevisionLinks } from '@/lib/documents/revision-links'

/**
 * Piloti's suggestion that this document replaces another. A suggestion only:
 * nothing changes for answers until a person who may edit the folder confirms
 * it (feld72, Jour fixe 2026-10-09: „Automatik nur als Vorschlag mit Rückfrage
 * und manueller Bestätigung").
 */
export function SuggestionNotice({
  suggestion,
  canManage,
  busy,
  onDecide,
}: {
  suggestion: NonNullable<RevisionLinks['suggestion']>
  canManage: boolean
  busy: boolean
  /** `true` links the two documents, `false` dismisses the suggestion. */
  onDecide: (olderId: string, linked: boolean) => void
}): JSX.Element {
  const t = useTranslations('files')
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed px-3 py-2.5" data-testid="revision-suggestion">
      <p className="text-foreground text-[13px] leading-snug">{t('preview.revision.suggestion', { name: suggestion.of.filename })}</p>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {t(BASIS_KEY[suggestion.basis])}
        {suggestion.reason ? ` ${suggestion.reason}` : ''}
      </p>
      {canManage ? (
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" size="sm" className="h-7" disabled={busy} onClick={() => onDecide(suggestion.of.id, true)}>
            {t('preview.revision.confirm')}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => onDecide(suggestion.of.id, false)}>
            {t('preview.revision.dismiss')}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{t('preview.revision.askEditor')}</p>
      )}
    </div>
  )
}

/** What the suggestion rests on, said in the reader's terms. Exhaustive over the wire values. */
const BASIS_KEY: Record<NonNullable<RevisionLinks['suggestion']>['basis'], string> = {
  title_block: 'preview.revision.basisTitleBlock',
  name: 'preview.revision.basisName',
  content: 'preview.revision.basisContent',
}
