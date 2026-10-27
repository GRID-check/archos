'use client'

import type { JSX } from 'react'

import { LoadMore } from '@/components/ui/load-more'
import { useTranslations } from '@/i18n'
import { documentReadFamily } from '@/lib/documents/document-status'
import type { DocumentHit } from '@/lib/search/search-wire'
import { useSearchLabels } from '../hooks/use-search-labels'
import { documentHitHref } from '../lib/search-hrefs'
import { COLUMN_SORT, columnSortState, REGISTER_COLUMNS, sortByColumn, type RegisterColumn } from '../lib/search-sort'
import type { SearchUrlState } from '../lib/search-url'
import type { SectionView } from '../lib/sections'
import {
  HitBadge,
  RegisterBody,
  RegisterCell,
  RegisterHead,
  RegisterHeadCell,
  RegisterLink,
  RegisterRow,
  RegisterTable,
  ShelfMark,
} from './search-atoms'

export interface SearchRegisterProps {
  state: SearchUrlState
  section: SectionView<DocumentHit> | undefined
  onStateChange: (next: SearchUrlState) => void
  onLoadMore: () => void
  /** Leave out the Projekt column where the scope is one project. */
  hideProject?: boolean
  /** The row the arrow keys are on (`document:id`). */
  activeKey: string | null
  /** The table's id and each row's, which the search field's combobox names. */
  listId?: string
  optionId?: (hit: DocumentHit) => string
}

/** Columns whose values are figures: right-aligned, as a register reads them. */
const NUMERIC: ReadonlySet<RegisterColumn> = new Set(['pages'])

/**
 * The register, the Planliste: one row per document, the columns a Jour fixe
 * reads, each header the search can order by a sort control. The header row
 * stays put while the rows scroll. It is a view of what Piloti read, not a
 * list anyone maintains.
 */
export function SearchRegister({ state, section, onStateChange, onLoadMore, hideProject = false, activeKey, listId, optionId }: SearchRegisterProps): JSX.Element {
  const t = useTranslations('search')
  const columns = REGISTER_COLUMNS.filter((column) => !(hideProject && column === 'project'))
  return (
    <>
      <RegisterTable id={listId} caption={t('register.caption')} testId="search-register">
        <RegisterHead>
          {columns.map((column) => {
            const label = t(`register.columns.${column}`)
            return (
              <RegisterHeadCell
                key={column}
                label={label}
                numeric={NUMERIC.has(column)}
                sort={
                  COLUMN_SORT[column] === null
                    ? undefined
                    : {
                        ariaLabel: t('register.sortBy', { column: label }),
                        direction: columnSortState(state, column),
                        onSort: () => onStateChange(sortByColumn(state, column)),
                      }
                }
              />
            )
          })}
        </RegisterHead>
        <RegisterBody>
          {(section?.hits ?? []).map((hit) => (
            <RegisterLine key={hit.id} hit={hit} columns={columns} active={activeKey === `document:${hit.id}`} id={optionId?.(hit)} />
          ))}
        </RegisterBody>
      </RegisterTable>
      {section ? (
        <LoadMore
          hasMore={section.nextCursor !== null}
          loading={section.loadingMore}
          failed={section.loadMoreFailed}
          onLoadMore={onLoadMore}
          loadMoreLabel={t('loadMore')}
          loadingLabel={t('loadingMore')}
          failedLabel={t('loadMoreFailed')}
        />
      ) : null}
    </>
  )
}

function RegisterLine({ hit, columns, active, id }: { hit: DocumentHit; columns: readonly RegisterColumn[]; active: boolean; id?: string }): JSX.Element {
  const t = useTranslations('search')
  const labels = useSearchLabels()
  const cell = (column: RegisterColumn): JSX.Element => {
    switch (column) {
      case 'planNumber':
        return <RegisterCell key={column} kind="code">{hit.planNumber}</RegisterCell>
      case 'planIndex':
        return <RegisterCell key={column} kind="code">{hit.planIndex}</RegisterCell>
      case 'planDate':
        return <RegisterCell key={column} kind="muted">{labels.day(hit.planDate)}</RegisterCell>
      case 'scale':
        return <RegisterCell key={column} kind="code">{hit.scale}</RegisterCell>
      case 'title':
        return (
          <RegisterCell key={column} kind="strong" title={hit.filename}>
            <RegisterLink href={documentHitHref(hit)}>{hit.title ?? hit.name}</RegisterLink>
          </RegisterCell>
        )
      case 'documentType': {
        const type = labels.documentType(hit.documentType)
        return <RegisterCell key={column} title={type ?? undefined}>{type}</RegisterCell>
      }
      case 'project':
        return (
          <RegisterCell key={column}>
            {hit.shelf === 'office_shelf' ? (
              <ShelfMark shelf="office_shelf" label={t('where.officeShelf')} />
            ) : hit.projectName ? (
              <ShelfMark shelf="project" label={hit.projectName} />
            ) : null}
          </RegisterCell>
        )
      case 'folder':
        return <RegisterCell key={column} title={hit.folderName ?? undefined}>{hit.folderName}</RegisterCell>
      case 'uploaded':
        return <RegisterCell key={column} kind="muted">{labels.day(hit.uploadedAt)}</RegisterCell>
      case 'pages':
        return <RegisterCell key={column} kind="figure">{hit.pageCount}</RegisterCell>
      case 'status':
        return (
          <RegisterCell key={column}>
            {hit.superseded ? <HitBadge tone="warning">{t('document.superseded')}</HitBadge> : labels.readState(documentReadFamily(hit.status))}
          </RegisterCell>
        )
    }
  }
  return (
    <RegisterRow active={active} id={id} testId={`search-register-row-${hit.id}`}>
      {columns.map(cell)}
    </RegisterRow>
  )
}
