'use client'

/**
 * „Ähnliche Stellen": where the office has written something like the passage
 * the reader is looking at, as a rail beside the document.
 *
 * Grouped project → document → passage, the reader's own project first, then
 * the other projects and the Büroablage by their best passage. A passage opens
 * its document on the stage, at the passage, marked; the rail stays, so the
 * reader walks the list against the source and comes back to it.
 *
 * The rail is a second pane read AGAINST the document (the design language's
 * "no overlay" row), never a drawer over it.
 */

import type { FC, KeyboardEvent } from 'react'
import { AlertTriangle, ArrowLeft, Building2, SearchX, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { ProjectClosedChip } from '@/components/projects/project-status'
import { SemanticMatch } from '@/features/documents/components/semantic-match'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import { useTranslations } from '@/i18n'
import type {
  SimilarDocument,
  SimilarGroup,
  SimilarPassagesRequest,
  SimilarPassagesResponse,
} from '@/lib/similar-passages/types'
import { similarDocumentsOf } from '@/lib/similar-passages/types'
import {
  loadSimilarPassages,
  useSimilarPassages,
  type OpenedPassage,
  type SimilarPassagesLoader,
} from '../lib/use-similar-passages'
import {
  SimilarDocumentLine,
  SimilarGroupHeading,
  SimilarList,
  SimilarPassageButton,
  SimilarRail,
  SimilarTag,
} from './similar-passage-atoms'

export interface SimilarPassagesPanelProps {
  request: SimilarPassagesRequest
  /** The similar passage on the stage, when one is. */
  opened: OpenedPassage | null
  onOpen: (passage: OpenedPassage) => void
  /** Back to the passage the search started from. */
  onBackToSource: () => void
  onClose: () => void
  /** The real client unless a preview passes a fixture. */
  load?: SimilarPassagesLoader
}

/** What a document is called on screen: the person's rename, else its file name. */
const nameOf = (document: SimilarDocument): string => document.displayName ?? document.filename

/** The key that marks one passage as open, stable within one answer. */
const passageKey = (document: SimilarDocument, index: number): string => `${document.documentId}#${index}`

/** Arrow keys walk the passages, as they walk the Fundstellen rail. */
const walkPassages = (event: KeyboardEvent<HTMLElement>): void => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-similar-passage]'))
  const index = buttons.findIndex((button) => button === document.activeElement)
  if (index === -1) return
  event.preventDefault()
  buttons[Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
}

const GroupHead: FC<{ group: SimilarGroup }> = ({ group }) => {
  const t = useTranslations('knowledge')
  if (group.kind === 'archiv') {
    return (
      <SimilarGroupHeading>
        <SourceSignalChip signal="office">{t('similar.groupArchiv')}</SourceSignalChip>
      </SimilarGroupHeading>
    )
  }
  return (
    <SimilarGroupHeading>
      <SourceSignalChip signal="project" title={group.project?.name}>
        {group.kind === 'current' ? t('similar.groupCurrent') : group.project?.name}
      </SourceSignalChip>
      {group.project?.status === 'closed' && <ProjectClosedChip />}
    </SimilarGroupHeading>
  )
}

const Results: FC<{
  response: SimilarPassagesResponse
  opened: OpenedPassage | null
  onOpen: (passage: OpenedPassage) => void
}> = ({ response, opened, onOpen }) => {
  const t = useTranslations('knowledge')
  const documents = similarDocumentsOf(response)
  const groupLabelOf = (group: SimilarGroup): string => {
    if (group.kind === 'archiv') return t('similar.groupArchiv')
    if (group.kind === 'current') return t('similar.groupCurrent')
    return group.project?.name ?? ''
  }
  if (documents.length === 0) {
    return (
      <EmptyState
        variant="bare"
        size="sm"
        icon={SearchX}
        title={t('similar.emptyTitle')}
        description={t('similar.emptyBody', { count: response.projectsSearched })}
        data-testid="similar-passages-empty"
      />
    )
  }
  return (
    <SimilarList>
      {response.groups.map((group) => (
        <section key={group.project?.id ?? 'archiv'} className="flex flex-col gap-2" data-similar-group={group.kind}>
          <GroupHead group={group} />
          {group.documents.map((document) => {
            const rank = documents.indexOf(document)
            return (
              <div key={document.documentId} className="flex flex-col gap-1">
                <SimilarDocumentLine
                  name={nameOf(document)}
                  meta={
                    <>
                      {document.stand && (
                        <SimilarTag>
                          {document.stand.kind === 'index'
                            ? document.stand.text
                            : t('similar.standDate', { date: document.stand.text })}
                        </SimilarTag>
                      )}
                      {document.superseded && <SimilarTag>{t('similar.superseded')}</SimilarTag>}
                    </>
                  }
                />
                {document.passages.map((passage, index) => {
                  const key = passageKey(document, index)
                  return (
                    <SimilarPassageButton
                      key={key}
                      current={opened?.key === key}
                      aria-label={
                        passage.page === null
                          ? t('similar.openPassageNoPage', { document: nameOf(document) })
                          : t('similar.openPassage', { document: nameOf(document), page: passage.page })
                      }
                      onClick={() =>
                        onOpen({
                          key,
                          documentId: document.documentId,
                          filename: document.filename,
                          title: nameOf(document),
                          contentType: document.contentType,
                          page: passage.page,
                          snippet: passage.snippet,
                          groupKind: group.kind,
                          groupLabel: groupLabelOf(group),
                          rank,
                        })
                      }
                    >
                      <SemanticMatch snippet={passage.snippet} page={passage.page} score={passage.score} />
                    </SimilarPassageButton>
                  )
                })}
              </div>
            )
          })}
        </section>
      ))}
    </SimilarList>
  )
}

export const SimilarPassagesPanel: FC<SimilarPassagesPanelProps> = ({
  request,
  opened,
  onOpen,
  onBackToSource,
  onClose,
  load = loadSimilarPassages,
}) => {
  const t = useTranslations('knowledge')
  const { state, retry } = useSimilarPassages(request, load)

  return (
    <SimilarRail label={t('similar.title')}>
      <div className="flex shrink-0 items-center gap-1.5">
        <SectionLabel as="h2">{t('similar.title')}</SectionLabel>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 pointer-coarse:size-11"
          onClick={onClose}
          aria-label={t('similar.close')}
        >
          <X aria-hidden />
        </Button>
      </div>
      <div className="shrink-0 rounded-lg border border-border bg-card px-2.5 py-2">
        <SectionLabel as="p">{t('similar.source')}</SectionLabel>
        <p className="mt-1 line-clamp-3 text-xs leading-snug text-foreground/80" data-testid="similar-source">
          {request.passage.text}
        </p>
        {opened && (
          <Button type="button" variant="ghost" size="sm" className="-ml-2 mt-1 h-7" onClick={onBackToSource}>
            <ArrowLeft aria-hidden />
            {t('similar.backToSource')}
          </Button>
        )}
      </div>
      <p className="shrink-0 text-xs text-muted-foreground">
        <Building2 aria-hidden className="mr-1 inline size-3 -translate-y-px" />
        {t('similar.scope')}
      </p>
      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={walkPassages}
        aria-busy={state.status === 'loading' || undefined}
      >
        {state.status === 'loading' && (
          <p className="inline-flex items-center gap-2 py-2 text-xs text-muted-foreground" role="status">
            <Spinner size="sm" />
            {t('similar.loading')}
          </p>
        )}
        {state.status === 'error' && (
          <EmptyState
            variant="bare"
            size="sm"
            tone="warning"
            icon={AlertTriangle}
            title={state.failure === 'held' ? t('similar.heldTitle') : t('similar.failedTitle')}
            description={state.failure === 'held' ? t('similar.heldBody') : t('similar.failedBody')}
            data-testid="similar-passages-error"
            action={
              state.failure === 'held' ? undefined : (
                <Button type="button" variant="outline" size="sm" onClick={retry}>
                  {t('similar.retry')}
                </Button>
              )
            }
          />
        )}
        {state.status === 'ready' && <Results response={state.response} opened={opened} onOpen={onOpen} />}
      </div>
    </SimilarRail>
  )
}
