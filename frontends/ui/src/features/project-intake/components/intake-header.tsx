'use client'

import type { JSX } from 'react'
import Link from 'next/link'
import { PencilLine, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BusyButton } from '@/components/ui/busy-button'
import { Progress } from '@/components/ui/progress'
import { ProjectUppyUpload } from '@/features/documents/components/project-uppy-upload'
import { useTranslations } from '@/i18n'
import type { IntakeView } from '@/lib/project-intake/types'
import { usePressed } from '../hooks/use-pressed'

/**
 * The status line: where the reading is, then what it holds. „23 Dokumente
 * gelesen · 41 Werte · 3 Widersprüche · 5 Rückfragen". While Piloti reads, a
 * determinate bar says how far: progress, not a second thing that spins (the
 * skeletons below are the page's one loop).
 */
export function IntakeStatusLine({ view }: { view: IntakeView }): JSX.Element {
  const t = useTranslations('projectIntake')
  const { counts } = view
  const parts = [
    t('counts.documents', { count: counts.documentsRead }),
    t('counts.values', { count: counts.suggested }),
    t('counts.contradictions', { count: counts.contradictions }),
    t('counts.questions', { count: counts.decisiveOpen }),
  ]
  const total = counts.documentsRead + counts.unreadDocuments
  return (
    <div className="space-y-1" data-testid="intake-status-line">
      <p className="text-sm font-medium" aria-live="polite">
        {t(`status.${view.status}`)}
      </p>
      {view.status !== 'waiting' && <p className="text-muted-foreground text-sm tabular-nums">{parts.join(' · ')}</p>}
      {view.status === 'reading' && total > 0 && (
        <Progress
          className="mt-2 max-w-xs"
          value={Math.round((counts.documentsRead / total) * 100)}
          aria-label={t('reading.progressAria', { read: counts.documentsRead, total })}
        />
      )}
      {counts.unreadDocuments > 0 && view.status !== 'reading' && (
        <p className="text-muted-foreground text-xs">{t('counts.unread', { count: counts.unreadDocuments })}</p>
      )}
    </div>
  )
}

/**
 * Header of the setup page. The frame above it already says „Projekterfassung";
 * this says where the reading stands and offers what a person may do now: read
 * what is new, add documents, or leave for the wizard, which stays the way to
 * fill the same profile by hand.
 */
export function IntakeHeader({
  view,
  projectId,
  busy,
  uploading,
  canUpload,
  onReread,
  onFiles,
}: {
  view: IntakeView
  projectId: string
  busy: boolean
  uploading: boolean
  /** Whether the header offers the upload: not while the page's own drop zone does, and not on a finished or closed one. */
  canUpload: boolean
  onReread: () => void | Promise<void>
  onFiles: (files: File[]) => void
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const [rereading, reread] = usePressed()
  const finished = view.status === 'completed'
  const nothingToRead = view.counts.documentsRead + view.counts.unreadDocuments === 0
  // A failed reading has „Erneut lesen" in its own alert; a second one here would be two of the same.
  const canRead = view.canDecide && !finished && !nothingToRead && view.status !== 'failed'
  return (
    <header
      className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
      data-testid="intake-header"
    >
      <div className="min-w-0 space-y-2">
        <IntakeStatusLine view={view} />
        {view.summary && view.status !== 'reading' && (
          <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">{view.summary}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
        {canUpload && !finished && (
          <ProjectUppyUpload
            projectId={projectId}
            onUpload={onFiles}
            isUploading={uploading}
            variant="outline"
            size="sm"
            label={t('header.addDocuments')}
            allowFolders
          />
        )}
        {canRead && (
          <BusyButton
            type="button"
            size="sm"
            variant="outline"
            icon={<RefreshCw aria-hidden />}
            busy={rereading}
            blocked={busy || view.status === 'reading'}
            busyLabel={t('busy.reread')}
            aria-label={t('header.rereadAria')}
            onClick={() => reread(async () => onReread())}
          >
            {t('header.reread')}
          </BusyButton>
        )}
        {!finished && (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/app/projects/${projectId}/intake`} aria-label={t('header.editSelfAria')}>
              <PencilLine aria-hidden />
              {t('header.editSelf')}
            </Link>
          </Button>
        )}
      </div>
    </header>
  )
}
