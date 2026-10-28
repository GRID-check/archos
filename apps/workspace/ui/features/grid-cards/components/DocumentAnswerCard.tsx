'use client'

import { useEffect, useMemo, useRef, type FC } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLocale, useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { searchHref } from '@/features/search/lib/search-hrefs'
import type { SearchScopeQuery } from '@/lib/search/search-wire'
import { FileCard } from '@/features/documents/components/file-card'
import { FileGrid, FileCardSkeleton } from '@/features/documents/components/file-grid'
import {
  useSurfacedDocuments,
  type SurfacedDocument,
} from '@/features/documents/hooks/use-surfaced-documents'
import { peekFile, ResolveErrorState, UnresolvedCard } from './document-surface'

/** The `workspace-search` question the files came from (`DocumentAnswerSearch` in `cards/models.py`). */
export interface DocumentAnswerSearch {
  text: string
  scope: 'office' | 'project' | 'office_shelf'
}

interface DocumentAnswerCardProps {
  title: string
  query?: string | null
  documents: SurfacedDocument[]
  search?: DocumentAnswerSearch | null
  projectId?: string | null
}

/** The search the card's link opens: the project's only with the project it was asked in, else the whole office. */
export function documentAnswerSearchHref(search: DocumentAnswerSearch, projectId: string | null): string {
  let scope: SearchScopeQuery = {}
  if (search.scope === 'office_shelf') scope = { scope: 'office_shelf' }
  else if (search.scope === 'project' && projectId) scope = { scope: 'project', projectId }
  return searchHref(scope, { text: search.text })
}

/**
 * Files the assistant asked the user to look at.
 *
 * Visual: the same raised {@link FileCard} (thumbnail well, name, summary)
 * the Files grid uses — without search ranking chrome. One file is that
 * card plus an automatic peek. Several close matches are a short FileGrid; when they came from the
 * workspace search, the card offers that search with every result.
 */
export const DocumentAnswerCard: FC<DocumentAnswerCardProps> = ({ title, query: _query, documents, search, projectId }) => {
  const t = useTranslations(chatCopy)
  const { locale } = useLocale()
  const { resolved, isLoading, error, retry } = useSurfacedDocuments(documents, projectId ?? null)
  const peekedOnce = useRef<string | null>(null)

  const cells = useMemo(
    () =>
      resolved.map((entry) => ({
        entry,
        file: entry.file
          ? {
              ...entry.file,
              // Live AI summary only. The retrieval snippet is a ranking
              // leftover (VLM dumps, page/score) — Files search can show it;
              // chat is "here is the file", not "here is why it ranked".
              summary: entry.file.summary ?? entry.surfaced.summary ?? null,
            }
          : null,
      })),
    [resolved],
  )

  const ready = cells.filter((cell) => cell.file)
  const single = !isLoading && !error && ready.length === 1 && cells.length === 1 ? ready[0] : null

  useEffect(() => {
    if (!single?.file) return
    if (peekedOnce.current === single.file.id) return
    peekedOnce.current = single.file.id
    peekFile(single.file, single.entry.docSource, projectId)
  }, [single, projectId])

  if (documents.length === 0) return null

  return (
    <section
      data-testid="document-answer-card"
      data-layout={single ? 'receipt' : 'choice'}
      className="w-full"
    >
      {isLoading ? (
        <FileGrid className="max-w-[220px]">
          {Array.from({ length: Math.min(documents.length, 3) }).map((_, i) => (
            <FileCardSkeleton key={i} />
          ))}
        </FileGrid>
      ) : error ? (
        <ResolveErrorState onRetry={retry} />
      ) : (
        <>
          {!single && cells.length > 1 && (
            <p className="text-muted-foreground mb-2 px-0.5 text-[11px] font-medium tracking-[-0.01em]">
              {title || t('documentAnswer.choose')}
            </p>
          )}
          <FileGrid className={single ? 'max-w-[220px]' : undefined}>
            {cells.map(({ entry, file }) =>
              file ? (
                <FileCard
                  key={entry.key}
                  file={file}
                  isSelected={false}
                  locale={locale}
                  onSelect={() => peekFile(file, entry.docSource, projectId)}
                  source={entry.docSource}
                  sourceLabel={entry.docSource ? t(`documentAnswer.source.${entry.docSource}`) : undefined}
                  hideFooter
                  ariaLabel={t('documentAnswer.openAria', { label: file.filename })}
                />
              ) : (
                <UnresolvedCard key={entry.key} entry={entry} projectId={projectId} />
              ),
            )}
          </FileGrid>
          {search && (
            <Button asChild size="sm" variant="ghost" className="mt-2">
              <Link href={documentAnswerSearchHref(search, projectId ?? null)} data-testid="document-answer-open-search">
                <Search className="size-3.5" aria-hidden="true" />
                {t('documentAnswer.openInSearch')}
              </Link>
            </Button>
          )}
        </>
      )}
    </section>
  )
}
