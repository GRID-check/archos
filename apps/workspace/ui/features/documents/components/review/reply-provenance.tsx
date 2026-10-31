'use client'

import type { JSX } from 'react'
import { useLocale, useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import type { AnnotationReplyView } from '@/lib/annotations/types'

/**
 * The line under a reply a BCF import brought in (migration 0195): who
 * imported it and, where the file said, the comment's own date. A colleague's
 * comment in a coordination file is theirs, but not something they wrote here.
 */
export function ReplyProvenance({ imported }: { imported: AnnotationReplyView['imported'] }): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const { locale } = useLocale()
  if (!imported) return null
  const name = imported.byName ?? t('review.someone')
  return (
    <p className="text-muted-foreground ml-8.5 text-[11px] leading-4" data-testid="thread-reply-imported">
      {imported.originalDate
        ? t('review.importedOn', { name, date: new Date(imported.originalDate).toLocaleDateString(locale, { dateStyle: 'medium' }) })
        : t('review.imported', { name })}
    </p>
  )
}
