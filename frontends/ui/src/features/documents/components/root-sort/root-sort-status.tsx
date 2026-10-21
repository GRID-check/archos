'use client'

/**
 * What a root sort shows while the server works it, and once it has moved
 * files. Presentational: the dialog passes the run's numbers in, and the
 * `/dev/root-sort` preview renders these same bodies from props.
 */

import type { JSX } from 'react'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import type { WorkingRootSortStatus } from '../../lib/root-sort-phase'

export interface RootSortProgressProps {
  status: WorkingRootSortStatus
  done: number
  total: number
}

export function RootSortProgress({ status, done, total }: RootSortProgressProps): JSX.Element {
  const t = useTranslations('files')
  const percent = total === 0 ? 0 : (done / total) * 100
  return (
    <div className="flex flex-col gap-3 py-2 text-sm">
      {status === 'grouping' ? (
        <div className="flex items-center gap-3">
          <Spinner aria-hidden />
          <p>{t('rootSort.progress.grouping')}</p>
        </div>
      ) : (
        <>
          <p>
            {status === 'judging'
              ? t('rootSort.progress.judging', { done, total })
              : status === 'applying'
                ? t('rootSort.progress.applying', { done, total })
                : t('rootSort.progress.undoing', { done, total })}
          </p>
          <Progress value={percent} />
        </>
      )}
      <p className="text-muted-foreground">{t('rootSort.progress.keepOpen')}</p>
    </div>
  )
}

export interface RootSortOutcomeProps {
  moved: number
  failedCount: number
  /** The first few names of the files that did not move; the rest are counted. */
  failedNames: readonly string[]
}

export function RootSortOutcome({ moved, failedCount, failedNames }: RootSortOutcomeProps): JSX.Element {
  const t = useTranslations('files')
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="font-medium">{t('rootSort.done.moved', { count: moved })}</p>
      {failedCount > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-error">{t('rootSort.done.failed', { count: failedCount })}</p>
          <ul className="text-muted-foreground list-disc pl-5">
            {failedNames.map((name, index) => (
              <li key={index} className="break-words">
                {name}
              </li>
            ))}
          </ul>
          {failedCount > failedNames.length && (
            <p className="text-muted-foreground">
              {t('rootSort.done.more', { count: failedCount - failedNames.length })}
            </p>
          )}
        </div>
      )}
      <p className="text-muted-foreground">{t('rootSort.done.foldersKept')}</p>
    </div>
  )
}
