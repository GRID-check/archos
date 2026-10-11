'use client'

/**
 * The Steckbrief tile (ADR-0091): where, when and with whom, as the overview's
 * other tiles show what they measure. The period is the figure, the address its
 * caption, and the people involved are listed below.
 *
 * It is a summary; nothing is edited on the dashboard. „Bearbeiten" opens the
 * editor in a dialog (`steckbrief-editor.tsx`). Whoever may not edit gets
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
import type { SteckbriefView } from '@/lib/projects/steckbrief-types'
import { SteckbriefPeople, SteckbriefPeriod, useProjectPeriodText } from './steckbrief-editor'

export interface ProjectSteckbriefProps {
  projectId: string
  steckbrief: SteckbriefView
  span?: BentoSpan
}

/** How many people the tile names before it counts the rest. */
const SHOWN = 6

export function ProjectSteckbrief({ projectId, steckbrief, span = 'wide' }: ProjectSteckbriefProps): JSX.Element {
  const t = useTranslations('projects')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const period = useProjectPeriodText(steckbrief)
  const shown = steckbrief.people.slice(0, SHOWN)
  const hidden = steckbrief.people.length - shown.length
  const former = steckbrief.people.filter((person) => person.kind === 'former').length

  const action =
    // A closed project's manager may still erase a person, so the dialog opens for them too.
    steckbrief.canEdit || steckbrief.canErase || hidden > 0 ? (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {steckbrief.canEdit && <Pencil className="size-3.5" aria-hidden />}
        {steckbrief.canEdit ? t('steckbrief.edit') : t('steckbrief.showAll')}
      </Button>
    ) : null

  const footer =
    steckbrief.people.length > 0
      ? [t('steckbrief.peopleCount', { count: steckbrief.people.length }), former > 0 ? t('steckbrief.formerCount', { count: former }) : null]
          .filter(Boolean)
          .join(' · ')
      : null

  return (
    <>
      <BentoTile label={t('steckbrief.heading')} icon={IdCard} span={span} action={action} footer={footer} data-testid="overview-steckbrief">
        <BentoFigure
          value={<span data-testid="steckbrief-period">{period}</span>}
          caption={<span data-testid="steckbrief-address">{steckbrief.address ?? t('steckbrief.addressMissing')}</span>}
        />
        <section aria-label={t('steckbrief.people')} className="space-y-2">
          <SectionLabel as="h3">{t('steckbrief.people')}</SectionLabel>
          {shown.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('steckbrief.noPeople')}</p>
          ) : (
            <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((person) => (
                <li key={person.id ?? person.userId ?? person.name} className="min-w-0 text-sm">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{person.name}</span>
                    {person.kind === 'former' && (
                      <Chip size="sm" variant="outline">
                        {t('steckbrief.former')}
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
              {t('steckbrief.more', { count: hidden })}
            </button>
          )}
        </section>
      </BentoTile>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent fullScreenOnMobile className="sm:max-w-2xl" data-testid="steckbrief-dialog">
          <DialogHeader>
            <DialogTitle>{t('steckbrief.heading')}</DialogTitle>
            <DialogDescription>{t('steckbrief.dialogDescription')}</DialogDescription>
          </DialogHeader>
          <section className="space-y-3" aria-labelledby="steckbrief-period-heading">
            <SectionLabel as="h3" id="steckbrief-period-heading">
              {t('steckbrief.period')}
            </SectionLabel>
            <SteckbriefPeriod projectId={projectId} steckbrief={steckbrief} onChanged={() => router.refresh()} />
          </section>
          <section className="space-y-3" aria-labelledby="steckbrief-people-heading">
            <SectionLabel as="h3" id="steckbrief-people-heading">
              {t('steckbrief.people')}
            </SectionLabel>
            <SteckbriefPeople projectId={projectId} steckbrief={steckbrief} onChanged={() => router.refresh()} />
          </section>
          <DialogFooter className="items-center sm:justify-between">
            <p className="text-muted-foreground text-xs">{t('steckbrief.privacy')}</p>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('steckbrief.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
