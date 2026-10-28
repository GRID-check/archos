'use client'

import { useCallback } from 'react'
import { useLocale, useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import type { AnnotationView } from '@/lib/annotations/types'
import { splitDocumentName } from '@/lib/documents/display-name'
import type { RevisionRef } from '@/lib/documents/revision-links'
import type { DocumentReview } from '../../hooks/use-document-review'
import type { CheckFixed } from './review-panel'

/**
 * The question that has Piloti check what is fixed: the open marks set on an
 * earlier Fassung of this document, or on a document this one replaces
 * (`from`), against what the review shows now. Asked in the person's words, as
 * they stand in the conversation afterwards; Piloti answers in each mark's
 * thread („In Fassung 3 behoben: …“ / „Weiterhin offen: …“) and changes no
 * status, which the `canvas` tools' descriptions hold it to. Pure.
 */
export function checkFixedQuestion(
  t: (key: string, values?: Record<string, string | number>) => string,
  locale: string,
  {
    marks,
    from,
    documentName,
    revisionLabel,
  }: {
    marks: readonly Pick<AnnotationView, 'number'>[]
    from: RevisionRef | null
    documentName: string
    revisionLabel: string | null
  }
): string {
  const numbers = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
    [...marks].sort((a, b) => a.number - b.number).map((mark) => String(mark.number))
  )
  if (from) {
    return t('review.checkFixed.seedFrom', {
      count: marks.length,
      numbers,
      from: from.filename,
      current: splitDocumentName(documentName).stem,
    })
  }
  return t('review.checkFixed.seed', {
    count: marks.length,
    numbers,
    current: revisionLabel ?? t('review.checkFixed.currentRevision'),
  })
}

/**
 * „Piloti prüfen lassen, was behoben ist": the review's own whole-document ask
 * of Piloti (`review.piloti.ask`, the one „Piloti prüfen lassen" in the header
 * runs), scoped to one group of marks, so it streams into the same header line
 * and the same conversation, one turn at a time. Only on request, never on an
 * upload. Undefined where Piloti cannot be asked here (no project, or a reader
 * who may not write the document).
 */
export function useCheckFixed(
  review: DocumentReview,
  { documentName, revisionLabel }: { documentName: string; revisionLabel: string | null }
): CheckFixed | undefined {
  const t = useTranslations(filesCopy)
  const { locale } = useLocale()
  const { piloti, canAnnotate, documentId } = review
  const ask = piloti.ask
  const check = useCallback<CheckFixed>(
    (marks, from) =>
      void ask({
        text: checkFixedQuestion(t, locale, { marks, from, documentName, revisionLabel }),
        region: null,
        effort: 'medium',
        checkFixed: { documentId: from?.id ?? documentId, annotationIds: marks.map((mark) => mark.id) },
      }),
    [ask, t, locale, documentName, revisionLabel, documentId]
  )
  return piloti.available && canAnnotate ? check : undefined
}
