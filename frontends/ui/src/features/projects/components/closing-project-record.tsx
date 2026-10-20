'use client'

/**
 * „Wer war dabei": the Steckbrief in the close dialog's „Was bleibt" step
 * (ADR-0091, ADR-0098). Closing makes the project read-only (ADR-0090), so
 * this is the moment to complete the record: the period so far, the members
 * Piloti lists on its own, and whoever worked on it without an account.
 *
 * It reads the Steckbrief from its route and reloads it after each change.
 * Nothing here blocks closing; a Steckbrief that fails to load is said, and
 * the dialog goes on.
 */

import { useCallback, useEffect, useState, type JSX } from 'react'
import { useRouter } from 'next/navigation'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import type { ProjectRecordView } from '@/lib/projects/project-record-types'
import { ProjectRecordPeople, useProjectPeriodText } from './project-record-editor'

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; projectRecord: ProjectRecordView }

export function ClosingProjectRecord({ projectId }: { projectId: string }): JSX.Element {
  const t = useTranslations('projects')
  const router = useRouter()
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/projects/${projectId}/project-record`)
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as Partial<ProjectRecordView>
      if (!Array.isArray(body.people)) throw new Error('not a Steckbrief')
      setLoad({ state: 'ready', projectRecord: body as ProjectRecordView })
    } catch {
      setLoad((current) => (current.state === 'ready' ? current : { state: 'failed' }))
    }
  }, [projectId])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <section className="space-y-2" aria-labelledby="closing-project-record" data-testid="closing-project-record">
      <SectionLabel as="h3" id="closing-project-record">
        {t('projectRecord.closing.heading')}
      </SectionLabel>
      <p className="text-muted-foreground text-xs leading-relaxed">{t('projectRecord.closing.description')}</p>
      {load.state === 'loading' && <Skeleton className="h-16 rounded-lg" />}
      {load.state === 'failed' && <p className="text-muted-foreground text-sm">{t('projectRecord.closing.loadFailed')}</p>}
      {load.state === 'ready' && (
        <ClosingPeople
          projectId={projectId}
          projectRecord={load.projectRecord}
          onChanged={() => {
            void reload()
            router.refresh()
          }}
        />
      )}
    </section>
  )
}

function ClosingPeople({
  projectId,
  projectRecord,
  onChanged,
}: {
  projectId: string
  projectRecord: ProjectRecordView
  onChanged: () => void
}): JSX.Element {
  const t = useTranslations('projects')
  const period = useProjectPeriodText(projectRecord)
  return (
    <div className="space-y-3">
      <p className="text-sm">
        <span className="text-muted-foreground">{t('projectRecord.period')}: </span>
        <span data-testid="closing-project-record-period">{period}</span>
      </p>
      <ProjectRecordPeople projectId={projectId} projectRecord={projectRecord} onChanged={onChanged} hint={false} />
    </div>
  )
}
