'use client'

/**
 * A project's Offene Punkte: the open Anmerkungen of every document of the
 * project on one page, grouped by document, for the Jour fixe, which is held
 * per project and not per sheet. Reached from the Dateien header, as the
 * Papierkorb is.
 *
 * Each row is the review list's own (`MarkRowContent`), as a link into that
 * document's Prüfansicht at the mark (`reviewFilesHref`: Dateien with `doc`,
 * `review` and `mark`, which the pane already answers). The filters are the
 * Jour fixe's two questions, whose points are mine and what is due; the
 * Protokoll carries what the filters show.
 *
 * The filters are in the page's address (`assignee=me`, `due=…`), and every
 * link into a review carries that address as `back`: closing the review
 * returns here, to the same selection, rather than leaving the reader in
 * Dateien. The list is read again when the page comes back (`useProjectMarks`).
 */

import { useState, type JSX } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, ArrowLeft, CheckCheck, FileText, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadMore } from '@/components/ui/load-more'
import { PageHeader } from '@/components/ui/page-header'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import {
  ASSIGNEE_ME,
  PROJECT_MARK_DUE,
  type ProjectMarkDue,
  type ProjectMarksFilters,
  type ProjectMarksResponse,
  type ProjectMarkView,
} from '@/lib/annotations/project-types'
import { useProjectMarks } from '../../hooks/use-project-marks'
import { reviewFilesHref } from '../../lib/open-review'
import { MarkRowContent, markRowClassName } from '../review/mark-row'
import { ProjectProtocolMenu } from './project-protocol-menu'

type AssigneeChoice = 'all' | 'me'
type DueChoice = 'all' | ProjectMarkDue

/** The filters the page opens with, and the server reads its first page for. */
export const OPEN_POINTS_DEFAULT_FILTERS: ProjectMarksFilters = {}

const filtersOf = (assignee: AssigneeChoice, due: DueChoice): ProjectMarksFilters => ({
  ...(assignee === 'me' ? { assignee: ASSIGNEE_ME } : {}),
  ...(due === 'all' ? {} : { due }),
})

/** The filters the page's address names; anything else is the default. */
function choicesOf(params: Pick<URLSearchParams, 'get'> | null): { assignee: AssigneeChoice; due: DueChoice } {
  const due = params?.get('due')
  return {
    assignee: params?.get('assignee') === ASSIGNEE_ME ? 'me' : 'all',
    due: due && (PROJECT_MARK_DUE as readonly string[]).includes(due) ? (due as ProjectMarkDue) : 'all',
  }
}

/**
 * This page's address with the filters on it, leaving out the defaults and
 * keeping any other param: the `back` of every link into a review.
 */
function hrefOf(pathname: string, current: string, assignee: AssigneeChoice, due: DueChoice): string {
  const params = new URLSearchParams(current)
  if (assignee === 'me') params.set('assignee', ASSIGNEE_ME)
  else params.delete('assignee')
  if (due !== 'all') params.set('due', due)
  else params.delete('due')
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

/** The marks by document, in the order the documents first appear (the list is ordered by document). */
function byDocument(marks: readonly ProjectMarkView[]): { documentId: string; documentName: string; marks: ProjectMarkView[] }[] {
  const groups = new Map<string, { documentId: string; documentName: string; marks: ProjectMarkView[] }>()
  for (const mark of marks) {
    const group = groups.get(mark.documentId) ?? { documentId: mark.documentId, documentName: mark.documentName, marks: [] }
    group.marks.push(mark)
    groups.set(mark.documentId, group)
  }
  return [...groups.values()]
}

export interface OpenPointsPanelProps {
  projectId: string
  /** The reader, so a mention of them stands out. */
  currentUserId: string | null
  /** The first page the server read for {@link OPEN_POINTS_DEFAULT_FILTERS}; null when that read failed. */
  initial: ProjectMarksResponse | null
}

export function OpenPointsPanel({ projectId, currentUserId, initial }: OpenPointsPanelProps): JSX.Element {
  const t = useTranslations('files')
  const router = useRouter()
  const pathname = usePathname() ?? `/app/projects/${projectId}/files/open-points`
  const searchParams = useSearchParams()
  const [assignee, setAssigneeState] = useState<AssigneeChoice>(() => choicesOf(searchParams).assignee)
  const [due, setDueState] = useState<DueChoice>(() => choicesOf(searchParams).due)
  const current = searchParams?.toString() ?? ''
  const here = hrefOf(pathname, current, assignee, due)
  /** A filter changes the list and the address, so Back from a review comes back to it. */
  const choose = (next: { assignee: AssigneeChoice; due: DueChoice }) => {
    setAssigneeState(next.assignee)
    setDueState(next.due)
    router.replace(hrefOf(pathname, current, next.assignee, next.due), { scroll: false })
  }
  const filters = filtersOf(assignee, due)
  const list = useProjectMarks(projectId, filters, { page: initial, filters: OPEN_POINTS_DEFAULT_FILTERS })
  const filtered = assignee !== 'all' || due !== 'all'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 p-4 sm:p-6" data-testid="open-points">
        <PageHeader
          title={t('openPoints.title')}
          subtitle={t('openPoints.subtitle')}
          action={
            <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <ProjectProtocolMenu projectId={projectId} filters={filters} />
              <Button asChild variant="ghost" size="sm">
                <Link href={`/app/projects/${projectId}/files`}>
                  <ArrowLeft className="size-4" aria-hidden />
                  {t('openPoints.back')}
                </Link>
              </Button>
            </div>
          }
        />

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid="open-points-filters">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs font-medium">{t('openPoints.filters.assignee')}</span>
            <ToggleGroup
              type="single"
              value={assignee}
              onValueChange={(value) => {
                if (value === 'all' || value === 'me') choose({ assignee: value, due })
              }}
              segmented
              size="sm"
              aria-label={t('openPoints.filters.assignee')}
            >
              <ToggleGroupItem value="all" data-testid="open-points-assignee-all">
                {t('openPoints.filters.all')}
              </ToggleGroupItem>
              <ToggleGroupItem value="me" data-testid="open-points-assignee-me">
                {t('openPoints.filters.me')}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs font-medium">{t('openPoints.filters.due')}</span>
            <ToggleGroup
              type="single"
              value={due}
              onValueChange={(value) => {
                if (value === 'all' || (PROJECT_MARK_DUE as readonly string[]).includes(value)) {
                  choose({ assignee, due: value as DueChoice })
                }
              }}
              segmented
              size="sm"
              aria-label={t('openPoints.filters.due')}
            >
              <ToggleGroupItem value="all" data-testid="open-points-due-all">
                {t('openPoints.filters.all')}
              </ToggleGroupItem>
              <ToggleGroupItem value="overdue" data-testid="open-points-due-overdue">
                {t('openPoints.filters.overdue')}
              </ToggleGroupItem>
              <ToggleGroupItem value="soon" title={t('openPoints.filters.soonHint')} data-testid="open-points-due-soon">
                {t('openPoints.filters.soon')}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        {list.load === 'loading' ? (
          <div className="flex justify-center py-12" role="status" aria-label={t('openPoints.loading')}>
            <Spinner size="sm" />
          </div>
        ) : list.load === 'error' ? (
          <EmptyState
            icon={AlertTriangle}
            tone="destructive"
            title={t('openPoints.loadError')}
            action={
              <Button variant="outline" size="sm" onClick={list.retry} data-testid="open-points-retry">
                <RefreshCw className="size-3.5" aria-hidden />
                {t('openPoints.retry')}
              </Button>
            }
          />
        ) : list.marks.length === 0 ? (
          <EmptyState
            icon={CheckCheck}
            title={t(filtered ? 'openPoints.empty.filteredTitle' : 'openPoints.empty.noneTitle')}
            description={t(filtered ? 'openPoints.empty.filteredBody' : 'openPoints.empty.noneBody')}
            data-testid="open-points-empty"
          />
        ) : (
          <>
            {byDocument(list.marks).map((group) => (
              <section
                key={group.documentId}
                aria-label={group.documentName}
                className="rounded-xl border"
                data-testid="open-points-document"
              >
                <div className="flex items-center gap-2 border-b px-3 py-2">
                  <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  <h2 className="text-foreground min-w-0 flex-1 truncate text-sm font-semibold">{group.documentName}</h2>
                  <Button asChild variant="ghost" size="sm" className="shrink-0">
                    <Link
                      href={reviewFilesHref(projectId, { documentId: group.documentId }, { back: here })}
                      aria-label={t('openPoints.openReviewOf', { name: group.documentName })}
                    >
                      {t('openPoints.openReview')}
                    </Link>
                  </Button>
                </div>
                <ul className="space-y-0.5 p-1">
                  {group.marks.map((mark) => (
                    <li key={mark.id}>
                      <Link
                        href={reviewFilesHref(
                          projectId,
                          { documentId: mark.documentId, annotationId: mark.id },
                          { back: here }
                        )}
                        className={markRowClassName()}
                        data-testid="open-point-row"
                      >
                        <MarkRowContent annotation={mark} viewerId={currentUserId} showPage />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <LoadMore
              hasMore={list.hasMore}
              loading={list.more === 'loading'}
              failed={list.more === 'error'}
              onLoadMore={list.loadMore}
              loadMoreLabel={t('openPoints.loadMore')}
              loadingLabel={t('openPoints.loadingMore')}
              failedLabel={t('openPoints.loadMoreFailed')}
            />
          </>
        )}
      </div>
    </div>
  )
}
