'use client'

import type { JSX } from 'react'
import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyStateDisc } from '@/components/ui/empty-state'
import { useTranslations } from '@/i18n'
import { projectIntakeCopy } from '@/i18n/namespaces/project-intake'
import type { IntakeView } from '@/lib/project-intake/types'

/** `2019-03` as the office writes a month: `03/2019`. */
export const formatMonth = (month: string): string => `${month.slice(5, 7)}/${month.slice(0, 4)}`

/**
 * The finished state, where the page's attention goes once nothing is left to
 * decide: what happened, and the way on to the project's overview.
 */
export function CompletedNote({ view }: { view: IntakeView }): JSX.Element {
  const t = useTranslations(projectIntakeCopy)
  return (
    <section
      role="status"
      className="border-border bg-card flex flex-col gap-4 rounded-lg border p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between"
      data-testid="intake-completed"
    >
      <div className="flex min-w-0 items-start gap-3">
        <EmptyStateDisc icon={CheckCircle2} size="sm" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {view.mode === 'closing' ? t('complete.doneClosing') : t('complete.done')}
          </p>
          <p className="text-muted-foreground text-sm">{t('complete.doneHint')}</p>
        </div>
      </div>
      <Button asChild variant="outline" size="sm" className="sm:shrink-0">
        <Link href={`/app/projects/${view.projectId}/settings`}>{t('complete.openProject')}</Link>
      </Button>
    </section>
  )
}
