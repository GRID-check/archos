'use client'

/**
 * The Steckbrief tile (ADR-0091): where, when and with whom, as the overview's
 * other tiles show what they measure. The period is the figure, the address its
 * caption, and the people involved are listed below.
 *
 * It is a summary; nothing is edited on the dashboard. „Bearbeiten" opens the
 * editor in a dialog (`project-record-editor.tsx`). Whoever may not edit gets
 * „Alle ansehen" instead, when the tile cannot show everyone or when they may
 * still erase a person.
 */

import { useState, type JSX } from 'react'
import { useRouter } from 'next/navigation'
import { IdCard, Pencil } from 'lucide-react'
import { BentoFigure, BentoTile, type BentoSpan } from '@/components/ui/bento'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import type { ProjectRecordView } from '@/lib/projects/project-record-types'
import { ProjectRecordPeople, ProjectRecordPeriod, useProjectPeriodText } from './project-record-editor'

export interface ProjectRecordProps {
  projectId: string
  projectRecord: ProjectRecordView
  span?: BentoSpan
}

/** How many people the tile names before it counts the rest. */
const SHOWN = 6

export function ProjectRecord({ projectId, projectRecord, span = 'wide' }: ProjectRecordProps): JSX.Element {
  const t = useTranslations('projects')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const period = useProjectPeriodText(projectRecord)
  const shown = projectRecord.people.slice(0, SHOWN)
  const hidden = projectRecord.people.length - shown.length
  const former = projectRecord.people.filter((person) => person.kind === 'former').length

  const action =
    // A closed project's manager may still erase a person, so the dialog opens for them too.
    projectRecord.canEdit || projectRecord.canErase || hidden > 0 ? (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {projectRecord.canEdit && <Pencil className="size-3.5" aria-hidden />}
        {projectRecord.canEdit ? t('projectRecord.edit') : t('projectRecord.showAll')}
      </Button>
    ) : null

  const footer =
    projectRecord.people.length > 0
      ? [t('projectRecord.peopleCount', { count: projectRecord.people.length }), former > 0 ? t('projectRecord.formerCount', { count: former }) : null]
          .filter(Boolean)
          .join(' · ')
      : null

  return (
    <>
      <BentoTile label={t('projectRecord.heading')} icon={IdCard} span={span} action={action} footer={footer} data-testid="overview-steckbrief">
        <BentoFigure
          value={<span data-testid="project-record-period">{period}</span>}
          caption={<span data-testid="project-record-address">{projectRecord.address ?? t('projectRecord.addressMissing')}</span>}
        />
        <section aria-label={t('projectRecord.people')} className="space-y-2">
          <SectionLabel as="h3">{t('projectRecord.people')}</SectionLabel>
          {shown.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('projectRecord.noPeople')}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((person) => (
                <li key={person.id ?? person.userId ?? person.name} className="min-w-0 text-sm">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{person.name}</span>
                    {person.kind === 'former' && (
                      <Chip size="sm" variant="outline">
                        {t('projectRecord.former')}
                      </Chip>
                    )}
                  </div>
                  {(person.function || person.company) && (
                    <p className="text-muted-foreground truncate text-xs">
                      {[person.function, person.company].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {hidden > 0 && (
            <button type="button" className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline" onClick={() => setOpen(true)}>
              {t('projectRecord.more', { count: hidden })}
            </button>
          )}
        </section>
      </BentoTile>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent fullScreenOnMobile className="sm:max-w-2xl" data-testid="project-record-dialog">
          <DialogHeader>
            <DialogTitle>{t('projectRecord.heading')}</DialogTitle>
            <DialogDescription>{t('projectRecord.dialogDescription')}</DialogDescription>
          </DialogHeader>
          <section className="space-y-3" aria-labelledby="project-record-period-heading">
            <SectionLabel as="h3" id="project-record-period-heading">
              {t('projectRecord.period')}
            </SectionLabel>
            <ProjectRecordPeriod projectId={projectId} projectRecord={projectRecord} onChanged={() => router.refresh()} />
          </section>
          <section className="space-y-3" aria-labelledby="project-record-people-heading">
            <SectionLabel as="h3" id="project-record-people-heading">
              {t('projectRecord.people')}
            </SectionLabel>
            <ProjectRecordPeople projectId={projectId} projectRecord={projectRecord} onChanged={() => router.refresh()} />
          </section>
          <DialogFooter className="items-center sm:justify-between">
            <p className="text-muted-foreground text-xs">{t('projectRecord.privacy')}</p>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('projectRecord.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
