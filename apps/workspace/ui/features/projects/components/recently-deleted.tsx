'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { LoadError } from '@/components/ui/load-error'
import { Button } from '@/components/ui/button'
import { useLocale, useTranslations } from '@/i18n'
import { projectsCopy } from '@/i18n/namespaces/projects'
import { ApiRequestError } from '@/adapters/api/api-error'
import {
  listDeletions,
  ProjectRequestError,
  restoreProject,
  type DeletionEntry,
} from '@/adapters/api/project-lifecycle-client'

interface RecentlyDeletedProps {
  /**
   * Whether the viewer holds the compliance capability the `/api/deletions`
   * endpoint requires. Passed from the projects page server component so
   * non-admins render nothing without issuing a guaranteed-403 request — and
   * so a real failure for an admin is distinguishable from "nothing pending".
   */
  canManageCompliance?: boolean
}

/**
 * Org-admin panel of pending deletions with restore. Renders nothing for
 * non-admins (no compliance capability) or when there is nothing pending, and
 * a small retryable error state when the list genuinely fails to load.
 */
export function RecentlyDeleted({ canManageCompliance = false }: RecentlyDeletedProps) {
  const t = useTranslations(projectsCopy)
  const { locale } = useLocale()
  const [entries, setEntries] = useState<DeletionEntry[]>([])
  const [error, setError] = useState(false)
  /** Entry currently being restored — disables its button to avoid double-fires. */
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
    [locale]
  )

  const refresh = useCallback(async () => {
    try {
      const rows = await listDeletions()
      setError(false)
      setEntries(rows.filter((row) => row.entityType === 'project'))
    } catch (error) {
      // A non-admin genuinely has no panel — treat 403 as "nothing to show".
      if (error instanceof ApiRequestError && error.status === 403) {
        setError(false)
        setEntries([])
        return
      }
      setError(true)
    }
  }, [])

  useEffect(() => {
    // Non-admins can't see the panel and their request is a guaranteed 403 —
    // skip the fetch entirely when we already know the capability is absent.
    if (!canManageCompliance) return
    void refresh()
  }, [canManageCompliance, refresh])

  const handleRestore = async (entry: DeletionEntry) => {
    setRestoringId(entry.id)
    try {
      await restoreProject(entry.entityId)
      toast.success(t('recentlyDeleted.restoreSuccess', { name: entry.displayName }))
      await refresh()
    } catch (error) {
      // The server's sentence when it sent one, ours when it did not.
      const serverMessage = error instanceof ProjectRequestError ? error.serverMessage : null
      toast.error(serverMessage ?? t('recentlyDeleted.restoreError'))
    } finally {
      setRestoringId(null)
    }
  }

  // Non-admins have no panel at all.
  if (!canManageCompliance) return null

  // Real failure (not a 403) — let a compliance admin retry instead of silently
  // showing an empty section they'd read as "nothing pending".
  if (error) {
    return (
      <section className="mt-8">
        <h2 className="text-muted-foreground text-sm font-medium">
          {t('recentlyDeleted.heading')}
        </h2>
        <LoadError className="mt-2" title={t('recentlyDeleted.loadError')} onRetry={refresh} />
      </section>
    )
  }

  if (entries.length === 0) return null

  return (
    <section className="mt-8">
      <h2 className="text-muted-foreground text-sm font-medium">
        {t('recentlyDeleted.heading')}
      </h2>
      <ul className="mt-2 flex flex-col gap-2">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-center justify-between rounded-control border p-3">
            <div>
              <p className="text-sm font-medium">{entry.displayName}</p>
              <p className="text-muted-foreground text-xs">
                {entry.status === 'failed'
                  ? t('recentlyDeleted.purgeFailed')
                  : t('recentlyDeleted.purgeAfter', {
                      date: dateFormatter.format(new Date(entry.purgeAfter)),
                    })}
              </p>
              {entry.status === 'failed' && entry.lastError && (
                <p className="text-destructive/80 mt-0.5 break-words font-mono text-xs">
                  {entry.lastError}
                </p>
              )}
            </div>
            {entry.status === 'pending' && (
              <Button
                variant="outline"
                size="sm"
                className="min-w-24"
                onClick={() => void handleRestore(entry)}
                disabled={restoringId === entry.id}
              >
                <Spinner
                  size="xs"
                  aria-hidden={restoringId !== entry.id}
                  className={
                    restoringId === entry.id
                      ? 'duration-snap transition-opacity ease-out motion-reduce:transition-none'
                      : 'opacity-0'
                  }
                />
                {t('recentlyDeleted.restore')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
