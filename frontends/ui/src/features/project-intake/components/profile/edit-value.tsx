'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { QuestionControl } from '@/features/projects/components/intake-question-field'
import { useTranslations } from '@/i18n'
import { intakeProfileStepCopy } from '@/i18n/namespaces/intake-profile-step'
import { projectIntakeCopy } from '@/i18n/namespaces/project-intake'
import { isIntakeAnswerProvided } from '@/lib/project-profile/intake-conditions'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import type { IntakeDecision, Suggestion } from '@/lib/project-intake/types'
import { usePressed } from '../../hooks/use-pressed'
import { questionForKey } from '../../lib/display'

/**
 * „Ändern": the person's own value for a row, asked with the wizard's own
 * control in a popover beside it, and written as their answer (`answer`, with
 * person evidence). A key no wizard question writes cannot be changed here.
 */
export function EditValue({
  item,
  label,
  busy,
  onDecide,
}: {
  item: Suggestion
  label: string
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element | null {
  const t = useTranslations(intakeProfileStepCopy)
  const tIntake = useTranslations(projectIntakeCopy)
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState<ProjectPrimitiveValue>(item.value)
  const [saving, save] = usePressed()
  const asked = questionForKey(item.key)
  if (!asked) return null
  // The control is named like the row it changes.
  const question = { ...asked, label }
  const provided = isIntakeAnswerProvided(value)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setValue(item.value)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground h-[30px] px-2.5 text-[13px] font-normal pointer-coarse:h-11"
          aria-label={t('findings.changeAria', { label })}
        >
          {t('findings.change')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-4" data-testid={`profile-edit-${item.key}`}>
        <p className="text-sm font-medium">{label}</p>
        <QuestionControl
          question={question}
          answerKey={item.key}
          answers={{ [item.key]: value }}
          error={null}
          onSetAnswer={(_key, next) => setValue(next)}
          onSetMode={() => undefined}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            {t('findings.cancel')}
          </Button>
          <BusyButton
            type="button"
            size="sm"
            busy={saving}
            blocked={busy || !provided}
            busyLabel={tIntake('busy.confirm')}
            onClick={() =>
              save(async () => {
                if (await onDecide([{ key: item.key, action: 'answer', value }])) setOpen(false)
              })
            }
          >
            {t('findings.save')}
          </BusyButton>
        </div>
      </PopoverContent>
    </Popover>
  )
}
