'use client'

import type { JSX } from 'react'
import { Building2, FileText, Folder, MessageSquare, MessageSquareWarning } from 'lucide-react'

import { LoadMore } from '@/components/ui/load-more'
import { useLocale, useTranslations } from '@/i18n'
import { ANNOTATION_KINDS, ANNOTATION_STATUSES } from '@/lib/annotations/types'
import { formatRelativeTime } from '@/lib/format'
import { termSegments } from '@/lib/text/term-segments'
import {
  SEARCH_KINDS,
  type AnnotationHit,
  type ConversationHit,
  type DocumentHit,
  type FolderHit,
  type ProjectHit,
  type SearchHit,
  type SearchKind,
} from '@/lib/search/search-wire'
import { useSearchLabels } from '../hooks/use-search-labels'
import { annotationHitHref, conversationHitHref, documentHitHref, folderHitHref, projectHitHref } from '../lib/search-hrefs'
import type { SectionView } from '../lib/sections'
import { Excerpt, HitBadge, MetaLine, MetaPart, PassageQuote, ResultRow, ResultSection, ShelfMark } from './search-atoms'

export interface SearchResultListProps {
  sections: Partial<Record<SearchKind, SectionView>>
  onLoadMore: (kind: SearchKind) => void
  /** The words searched for, set apart in the passages. */
  text: string
  /** The hit the arrow keys are on (`kind:id`). */
  activeKey: string | null
  /** Each kind's listbox id and each hit's option id, which the search field's combobox names. */
  listId?: (kind: SearchKind) => string
  optionId?: (hit: SearchHit) => string
}

/**
 * The result as a list: one section per kind in the contract's order, each
 * hit with its name, one line of what it is and where it sits, the shelf it is
 * kept on as its provenance mark, and, for a document found by what it says,
 * the passage with the words set apart and its page.
 */
export function SearchResultList({ sections, onLoadMore, text, activeKey, listId, optionId }: SearchResultListProps): JSX.Element {
  return (
    <>
      {SEARCH_KINDS.map((kind) => {
        const section = sections[kind]
        if (!section || section.hits.length === 0) return null
        return (
          <KindSection
            key={kind}
            kind={kind}
            section={section}
            text={text}
            activeKey={activeKey}
            onLoadMore={() => onLoadMore(kind)}
            listId={listId?.(kind)}
            optionId={optionId}
          />
        )
      })}
    </>
  )
}

/**
 * One hit, drawn as its kind draws it. The list renders it as a link; the ⌘K
 * palette renders the same row inside its own option (`ResultRowFrameProvider`).
 */
export function HitRow({ hit, text, active = false, id }: { hit: SearchHit; text: string; active?: boolean; id?: string }): JSX.Element {
  switch (hit.kind) {
    case 'document':
      return <DocumentRow hit={hit} text={text} active={active} id={id} />
    case 'annotation':
      return <AnnotationRow hit={hit} active={active} id={id} />
    case 'folder':
      return <FolderRow hit={hit} active={active} id={id} />
    case 'project':
      return <ProjectRow hit={hit} active={active} id={id} />
    case 'conversation':
      return <ConversationRow hit={hit} active={active} id={id} />
  }
}

function KindSection({
  kind,
  section,
  text,
  activeKey,
  onLoadMore,
  listId,
  optionId,
}: {
  kind: SearchKind
  section: SectionView
  text: string
  activeKey: string | null
  onLoadMore: () => void
  listId?: string
  optionId?: (hit: SearchHit) => string
}): JSX.Element {
  const t = useTranslations('search')
  const total = section.totalIsLowerBound ? t('totalAtLeast', { count: section.total }) : String(section.total)
  const row = (hit: SearchHit): JSX.Element => (
    <HitRow key={hit.id} hit={hit} text={text} active={activeKey === `${hit.kind}:${hit.id}`} id={optionId?.(hit)} />
  )
  return (
    <ResultSection
      title={t(`kinds.${kind}`)}
      count={total}
      listId={listId}
      testId={`search-section-${kind}`}
      footer={
        <LoadMore
          hasMore={section.nextCursor !== null}
          loading={section.loadingMore}
          failed={section.loadMoreFailed}
          onLoadMore={onLoadMore}
          auto={false}
          loadMoreLabel={t('loadMore')}
          loadingLabel={t('loadingMore')}
          failedLabel={t('loadMoreFailed')}
        />
      }
    >
      {section.hits.map(row)}
    </ResultSection>
  )
}

/** Where a hit is kept, as the provenance mark: the project, or the Büroablage. */
function useShelfMark(): (shelf: 'project' | 'office_shelf', projectName: string | null) => JSX.Element | null {
  const tWhere = useTranslations('search.where')
  return (shelf, projectName) => {
    if (shelf === 'office_shelf') return <ShelfMark shelf="office_shelf" label={tWhere('officeShelf')} />
    return projectName ? <ShelfMark shelf="project" label={projectName} /> : null
  }
}

function DocumentRow({ hit, text, active, id }: { hit: DocumentHit; text: string; active: boolean; id?: string }): JSX.Element {
  const t = useTranslations('search')
  const labels = useSearchLabels()
  const mark = useShelfMark()
  const type = labels.documentType(hit.documentType)
  const day = labels.day(hit.planDate ?? hit.documentDate)
  return (
    <ResultRow
      href={documentHitHref(hit)}
      icon={FileText}
      title={hit.title ?? hit.name}
      active={active}
      id={id}
      testId={`search-hit-document-${hit.id}`}
      meta={
        <MetaLine
          parts={[
            type ? <MetaPart key="type">{type}</MetaPart> : null,
            hit.folderName ? <MetaPart key="folder">{hit.folderName}</MetaPart> : null,
            hit.planNumber ? <MetaPart key="number" code>{hit.planNumber}</MetaPart> : null,
            hit.planIndex ? <MetaPart key="index">{t('document.index', { index: hit.planIndex })}</MetaPart> : null,
            hit.scale ? <MetaPart key="scale" code>{hit.scale}</MetaPart> : null,
            day ? <MetaPart key="day">{day}</MetaPart> : null,
          ]}
        />
      }
      aside={
        <>
          {hit.superseded ? <HitBadge tone="warning">{t('document.superseded')}</HitBadge> : null}
          {mark(hit.shelf, hit.projectName)}
        </>
      }
    >
      {hit.passage ? (
        <PassageQuote
          segments={termSegments(hit.passage.text, text)}
          page={hit.passage.page !== null ? t('passage.page', { page: hit.passage.page }) : undefined}
        />
      ) : null}
    </ResultRow>
  )
}

function AnnotationRow({ hit, active, id }: { hit: AnnotationHit; active: boolean; id?: string }): JSX.Element {
  const t = useTranslations('search')
  const mark = useShelfMark()
  const kind = (ANNOTATION_KINDS as readonly string[]).includes(hit.annotationKind) ? t(`annotation.kinds.${hit.annotationKind}`) : hit.annotationKind
  const status = (ANNOTATION_STATUSES as readonly string[]).includes(hit.status) ? t(`annotation.statuses.${hit.status}`) : hit.status
  return (
    <ResultRow
      href={annotationHitHref(hit)}
      icon={MessageSquareWarning}
      title={t('annotation.on', { document: hit.documentName })}
      active={active}
      id={id}
      testId={`search-hit-annotation-${hit.id}`}
      meta={<MetaLine parts={[<MetaPart key="kind">{kind}</MetaPart>, <MetaPart key="status">{status}</MetaPart>]} />}
      aside={mark(hit.projectId ? 'project' : 'office_shelf', hit.projectName)}
    >
      <Excerpt>{hit.excerpt}</Excerpt>
    </ResultRow>
  )
}

function FolderRow({ hit, active, id }: { hit: FolderHit; active: boolean; id?: string }): JSX.Element {
  const mark = useShelfMark()
  return (
    <ResultRow
      href={folderHitHref(hit)}
      icon={Folder}
      title={hit.name}
      active={active}
      id={id}
      aside={mark(hit.shelf, hit.projectName)}
      testId={`search-hit-folder-${hit.id}`}
    >
      {hit.excerpt ? <Excerpt>{hit.excerpt}</Excerpt> : null}
    </ResultRow>
  )
}

function ProjectRow({ hit, active, id }: { hit: ProjectHit; active: boolean; id?: string }): JSX.Element {
  return (
    <ResultRow href={projectHitHref(hit)} icon={Building2} title={hit.name} active={active} id={id} testId={`search-hit-project-${hit.id}`}>
      {hit.excerpt ? <Excerpt>{hit.excerpt}</Excerpt> : null}
    </ResultRow>
  )
}

function ConversationRow({ hit, active, id }: { hit: ConversationHit; active: boolean; id?: string }): JSX.Element {
  const { locale } = useLocale()
  const mark = useShelfMark()
  return (
    <ResultRow
      href={conversationHitHref(hit)}
      icon={MessageSquare}
      title={hit.title}
      active={active}
      id={id}
      meta={<MetaPart>{formatRelativeTime(hit.updatedAt, locale)}</MetaPart>}
      aside={hit.projectName ? mark('project', hit.projectName) : null}
      testId={`search-hit-conversation-${hit.id}`}
    />
  )
}
