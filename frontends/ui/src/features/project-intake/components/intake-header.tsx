'use client'

import type { JSX } from 'react'
import Link from 'next/link'
import { PencilLine, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ProjectUppyUpload } from '@/features/documents/components/project-uppy-upload'
import { useTranslations } from '@/i18n'
import type { IntakeView } from '@/lib/project-intake/types'

/** The status line: where the reading is, then what it holds. „23 Dokumente gelesen · 41 Werte · 3 Widersprüche · 5 Rückfragen". */
export function IntakeStatusLine({ view }: { view: IntakeView }): JSX.Element {
  const t = useTranslations('projectIntake')
  const { counts } = view
  const parts = [
    t('counts.documents', { count: counts.documentsRead }),
    t('counts.values', { count: counts.suggested }),
    t('counts.contradictions', { count: counts.contradictions }),
    t('counts.questions', { count: counts.decisiveOpen }),
  ]
  return (
    <div className="space-y-1" data-testid="intake-status-line">
      <p className="flex items-center gap-2 text-sm font-medium" aria-live="polite">
        {view.status === 'reading' && <Spinner size="sm" aria-hidden />}
        {t(`status.${view.status}`)}
      </p>
      {view.status !== 'waiting' && <p className="text-muted-foreground text-sm tabular-nums">{parts.join(' · ')}</p>}
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
  canUpload: boolean
  onReread: () => void
  onFiles: (files: File[]) => void
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const finished = view.status === 'completed'
  const nothingToRead = view.counts.documentsRead + view.counts.unreadDocuments === 0
  const canRead = view.canDecide && !finished && !nothingToRead
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between" data-testid="intake-header">
      <div className="min-w-0 space-y-2">
        <IntakeStatusLine view={view} />
        {view.summary && view.status !== 'reading' && (
          <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">{view.summary}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || view.status === 'reading'}
            aria-label={t('header.rereadAria')}
            onClick={onReread}
          >
            <RefreshCw aria-hidden />
            {t('header.reread')}
          </Button>
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
