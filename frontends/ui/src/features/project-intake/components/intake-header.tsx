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
  const read = [t('counts.documents', { count: counts.documentsRead }), t('counts.values', { count: counts.suggested })]
  const toDecide = [
    t('counts.contradictions', { count: counts.contradictions }),
    t('counts.questions', { count: counts.decisiveOpen }),
  ]
  const hasOpen = counts.contradictions > 0 || counts.decisiveOpen > 0
  const total = counts.documentsRead + counts.unreadDocuments
  return (
    <div className="space-y-1" data-testid="intake-status-line">
      <p className="text-sm font-medium" aria-live="polite">
        {t(`status.${view.status}`)}
      </p>
      {view.status !== 'waiting' && (
        // One line in the order the counts were always read in. On a phone the
        // second half goes FIRST and takes the ink: what waits for a decision
        // is the task, and „23 Dokumente gelesen" is the context. The
        // separator belongs to the one-line form only.
        <p className="text-muted-foreground text-sm tabular-nums max-sm:flex max-sm:flex-col">
          <span>{read.join(' · ')}</span>
          <span className="max-sm:hidden"> · </span>
          <span className={hasOpen ? 'max-sm:text-foreground max-sm:order-first max-sm:font-medium' : 'max-sm:order-last'}>
            {toDecide.join(' · ')}
          </span>
        </p>
      )}
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
 * The reading's line above the steps. The reading runs in the background while
 * the person works through the steps, so where it stands is on every step,
 * kept to one status line and three controls: add documents, read again, and a
 * quiet way to the Briefing-Editor (the wizard), which stays the way to fill
 * the same profile by hand. What Piloti says about what it read (the summary)
 * and the reading's milestones belong to the Erfassung step, which draws them
 * itself; on that step the frame leaves the status line out (`showStatus`).
 */
export function IntakeHeader({
  view,
  projectId,
  busy,
  uploading,
  canUpload,
  showStatus = true,
  onReread,
  onFiles,
}: {
  view: IntakeView
  projectId: string
  busy: boolean
  uploading: boolean
  /** Whether the header offers the upload: not while the page's own drop zone does, and not on a finished or closed one. */
  canUpload: boolean
  /** Draw the status line; off on the Erfassung step, which shows the reading in full. */
  showStatus?: boolean
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
      <div className="min-w-0">{showStatus && <IntakeStatusLine view={view} />}</div>
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
          <Button asChild size="sm" variant="ghost" className="text-muted-foreground">
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
