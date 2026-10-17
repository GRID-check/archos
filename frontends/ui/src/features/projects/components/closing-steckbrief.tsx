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
import type { SteckbriefView } from '@/lib/projects/steckbrief-types'
import { SteckbriefPeople, useProjectPeriodText } from './steckbrief-editor'

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; steckbrief: SteckbriefView }

export function ClosingSteckbrief({ projectId }: { projectId: string }): JSX.Element {
  const t = useTranslations('projects')
  const router = useRouter()
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/projects/${projectId}/steckbrief`)
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as Partial<SteckbriefView>
      if (!Array.isArray(body.people)) throw new Error('not a Steckbrief')
      setLoad({ state: 'ready', steckbrief: body as SteckbriefView })
    } catch {
      setLoad((current) => (current.state === 'ready' ? current : { state: 'failed' }))
    }
  }, [projectId])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <section className="space-y-2" aria-labelledby="closing-steckbrief" data-testid="closing-steckbrief">
      <SectionLabel as="h3" id="closing-steckbrief">
        {t('steckbrief.closing.heading')}
      </SectionLabel>
      <p className="text-muted-foreground text-xs leading-relaxed">{t('steckbrief.closing.description')}</p>
      {load.state === 'loading' && <Skeleton className="h-16 rounded-lg" />}
      {load.state === 'failed' && <p className="text-muted-foreground text-sm">{t('steckbrief.closing.loadFailed')}</p>}
      {load.state === 'ready' && (
        <ClosingPeople
          projectId={projectId}
          steckbrief={load.steckbrief}
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
  steckbrief,
  onChanged,
}: {
  projectId: string
  steckbrief: SteckbriefView
  onChanged: () => void
}): JSX.Element {
  const t = useTranslations('projects')
  const period = useProjectPeriodText(steckbrief)
  return (
    <div className="space-y-3">
      <p className="text-sm">
        <span className="text-muted-foreground">{t('steckbrief.period')}: </span>
        <span data-testid="closing-steckbrief-period">{period}</span>
      </p>
      <SteckbriefPeople projectId={projectId} steckbrief={steckbrief} onChanged={onChanged} hint={false} />
    </div>
  )
}
