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
import {
  Excerpt,
  MatchHint,
  MetaLine,
  MetaPart,
  PassageQuote,
  ResultRow,
  ResultSection,
  ShelfMark,
  SupersededMark,
  WherePart,
} from './search-atoms'

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
 * hit with its name, where it lives (the shelf as its provenance mark, then
 * the folder), one line of what it is, and, for a document found by what it
 * says, the passage with the words set apart and its page. A document found by
 * words says, quietly, what they were found in.
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

/**
 * Where a hit lives: the shelf as the provenance mark (the project, or the
 * Büroablage), then its folder. The names wrap rather than cut, so the whole
 * of a long project name is read without a pointer.
 */
function useWhere(): (shelf: 'project' | 'office_shelf', projectName: string | null, folderName?: string | null) => JSX.Element | null {
  const tWhere = useTranslations('search.where')
  return (shelf, projectName, folderName = null) => {
    const mark =
      shelf === 'office_shelf' ? (
        <ShelfMark shelf="office_shelf" label={tWhere('officeShelf')} wrap />
      ) : projectName ? (
        <ShelfMark shelf="project" label={projectName} wrap />
      ) : null
    if (!mark && !folderName) return null
    return (
      <>
        {mark}
        {folderName ? (
          <WherePart label={tWhere('folder')} after={mark !== null}>
            {folderName}
          </WherePart>
        ) : null}
      </>
    )
  }
}

const MATCHED_ON_ORDER = ['name', 'reading', 'content'] as const

function DocumentRow({ hit, text, active, id }: { hit: DocumentHit; text: string; active: boolean; id?: string }): JSX.Element {
  const t = useTranslations('search')
  const labels = useSearchLabels()
  const where = useWhere()
  const type = labels.documentType(hit.documentType)
  const day = labels.day(hit.planDate ?? hit.documentDate)
  // „Inhalt“ goes without saying under the passage that shows it; the hint
  // names only what the row does not show (the name, what Piloti read).
  const matchedOn = text.trim()
    ? MATCHED_ON_ORDER.filter((reason) => hit.matchedOn.includes(reason) && !(reason === 'content' && hit.passage))
    : []
  return (
    <ResultRow
      href={documentHitHref(hit)}
      icon={FileText}
      title={hit.title ?? hit.name}
      active={active}
      id={id}
      testId={`search-hit-document-${hit.id}`}
      where={where(hit.shelf, hit.projectName, hit.folderName)}
      meta={
        <MetaLine
          parts={[
            type ? <MetaPart key="type">{type}</MetaPart> : null,
            hit.planNumber ? <MetaPart key="number" code>{hit.planNumber}</MetaPart> : null,
            hit.planIndex ? <MetaPart key="index">{t('document.index', { index: hit.planIndex })}</MetaPart> : null,
            hit.scale ? <MetaPart key="scale" code>{hit.scale}</MetaPart> : null,
            day ? <MetaPart key="day">{day}</MetaPart> : null,
          ]}
        />
      }
      aside={hit.superseded ? <SupersededMark /> : null}
    >
      {hit.passage ? (
        <PassageQuote
          segments={termSegments(hit.passage.text, text)}
          page={hit.passage.page !== null ? t('passage.page', { page: hit.passage.page }) : undefined}
        />
      ) : null}
      {matchedOn.length > 0 ? <MatchHint label={t('matchedOn.label')} parts={matchedOn.map((reason) => t(`matchedOn.${reason}`))} /> : null}
    </ResultRow>
  )
}

function AnnotationRow({ hit, active, id }: { hit: AnnotationHit; active: boolean; id?: string }): JSX.Element {
  const t = useTranslations('search')
  const where = useWhere()
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
      where={where(hit.shelf, hit.projectName)}
      meta={<MetaLine parts={[<MetaPart key="kind">{kind}</MetaPart>, <MetaPart key="status">{status}</MetaPart>]} />}
    >
      <Excerpt>{hit.excerpt}</Excerpt>
    </ResultRow>
  )
}

function FolderRow({ hit, active, id }: { hit: FolderHit; active: boolean; id?: string }): JSX.Element {
  const where = useWhere()
  return (
    <ResultRow
      href={folderHitHref(hit)}
      icon={Folder}
      title={hit.name}
      active={active}
      id={id}
      where={where(hit.shelf, hit.projectName)}
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
  const where = useWhere()
  return (
    <ResultRow
      href={conversationHitHref(hit)}
      icon={MessageSquare}
      title={hit.title}
      active={active}
      id={id}
      meta={<MetaPart>{formatRelativeTime(hit.updatedAt, locale)}</MetaPart>}
      where={hit.projectName ? where('project', hit.projectName) : null}
      testId={`search-hit-conversation-${hit.id}`}
    />
  )
}
