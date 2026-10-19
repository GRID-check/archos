'use client'

import { useLocale, useTranslations } from '@/i18n'
import { formatBytes } from '@/lib/format'
import { fileFormatMessage } from '../document-kind'
import type { FileItem } from '../file-types'

/**
 * What the file IS, in one quiet line under its name: "PDF · 12 Seiten ·
 * 2,4 MB". The name alone left the reader to infer the format from a suffix
 * the truncation had usually eaten, and the length of the document — the first
 * thing anyone wants to know before asking about it — appeared nowhere. A page
 * count is left out for images and models, where it means nothing.
 *
 * One hook for both headers that name an open document (the chat peek's and
 * the preview's), so the two say it in the same words. The preview used to
 * state the format and the size as two rows of a Properties list instead.
 */
export function useFileFacts(file: FileItem): string {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const format = fileFormatMessage(file)
  const paged = format?.key !== 'image' && format?.key !== 'ifc'
  const facts: string[] = []
  if (format) facts.push(t(`preview.formats.${format.key}`, format.values))
  if (paged && file.pageCount && file.pageCount > 0) {
    facts.push(t('preview.pageCount', { count: file.pageCount }))
  }
  if (file.fileSize && file.fileSize > 0) facts.push(formatBytes(file.fileSize, locale))
  return facts.join(' · ')
}
