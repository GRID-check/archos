'use client'

/**
 * Setting a scoped LLM limit (ADR-0015): the dialog the organization's budget
 * card opens per member and per project, and the one a project's own usage
 * section opens for itself. One editor, so the rule about what a blank field
 * means is written once.
 *
 * A dialog, not a popover: two fields and a Save are a short form, and the
 * design language gives a form a `Dialog`. That is also what makes it a
 * bottom sheet with a full-width field and a reachable Save on a phone, where
 * a 256px popover hung off a 32px icon button.
 */

import { type FC, type ReactNode, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ApiRequestError } from '@/adapters/api/api-error'
import { removeBudgetPolicy, setBudgetPolicy } from '@/adapters/api/budgets-client'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useLocale, useTranslations } from '@/i18n'
import { parseDecimalInput } from '@/lib/text/parse-decimal'

/** A budget policy as `/api/organization/budgets` sends it. Limits are decimal strings. */
export interface PolicyDto {
  id: string
  scope: 'organization' | 'member' | 'project'
  subjectId: string | null
  dailyLimit: string | null
  monthlyLimit: string | null
}

/**
 * A limit field: blank is "no limit", a non-negative number is the limit, and
 * anything else is invalid.
 *
 * This used to be one function returning `null` for both blank and garbage,
 * and `null` is what the route stores as NO LIMIT: an admin who typed "fünf"
 * or "-5" into the daily limit silently removed it. Invalid now blocks Save.
 */
export type LimitInput = { ok: true; value: number | null } | { ok: false }

export const readLimit = (value: string, locale: string): LimitInput => {
  const parsed = parseDecimalInput(value, locale)
  if (parsed.status === 'blank') return { ok: true, value: null }
  if (parsed.status === 'valid' && parsed.value >= 0) return { ok: true, value: parsed.value }
  return { ok: false }
}

/** Dialog editor for one subject's daily/monthly limit (used per member row
 * and for existing project policies). */
export const LimitEditor: FC<{
  scope: 'member' | 'project'
  subjectId: string
  /** The subject's limit today, or undefined when it has none (Remove is then hidden). */
  current: Pick<PolicyDto, 'dailyLimit' | 'monthlyLimit'> | undefined
  /** The unit word for the field labels ("credits" / "tokens"). */
  unitWord: string
  /** Who the limit is for (name or email), shown under the title. */
  subjectLabel?: string
  onSaved: () => Promise<void>
  trigger: ReactNode
}> = ({ scope, subjectId, current, unitWord, subjectLabel, onSaved, trigger }) => {
  const t = useTranslations('organization')
  const tCommon = useTranslations('common')
  const { locale } = useLocale()
  const [open, setOpen] = useState(false)
  const [daily, setDaily] = useState('')
  const [monthly, setMonthly] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setDaily(
        current?.dailyLimit !== null && current !== undefined
          ? Number.parseFloat(current.dailyLimit).toString()
          : ''
      )
      setMonthly(
        current?.monthlyLimit !== null && current !== undefined
          ? Number.parseFloat(current.monthlyLimit).toString()
          : ''
      )
    }
  }, [open, current])

  const dailyInput = readLimit(daily, locale)
  const monthlyInput = readLimit(monthly, locale)
  const limitsValid = dailyInput.ok && monthlyInput.ok

  const save = async (): Promise<void> => {
    if (!dailyInput.ok || !monthlyInput.ok) return
    setBusy(true)
    try {
      await setBudgetPolicy({
        scope,
        subjectId,
        dailyLimit: dailyInput.value,
        monthlyLimit: monthlyInput.value,
      })
      toast.success(t('budgets.policySaved'))
      setOpen(false)
      await onSaved()
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 422) {
        // The server's validation text is English and technical; the reader
        // gets the sentence in their language, as the organization limits do.
        toast.error(t('budgets.limitsRejected'))
        return
      }
      toast.error(t('budgets.policySaveError'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      await removeBudgetPolicy({ scope, subjectId })
      toast.success(t('budgets.policyRemoved'))
      setOpen(false)
      await onSaved()
    } catch {
      toast.error(t('budgets.policyRemoveError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="sm:max-w-sm"
        closeLabel={tCommon('actions.close')}
        {...(subjectLabel ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader>
          <DialogTitle>{t('budgets.setLimit')}</DialogTitle>
          {subjectLabel && <DialogDescription>{subjectLabel}</DialogDescription>}
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor={`limit-daily-${subjectId}`}>
              {t('budgets.dailyLimit', { unit: unitWord })}
            </FieldLabel>
            <Input
              id={`limit-daily-${subjectId}`}
              inputMode="decimal"
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              placeholder={t('budgets.noLimitPlaceholder')}
              aria-invalid={!dailyInput.ok || undefined}
            />
            {!dailyInput.ok && <FieldError>{t('budgets.limitInvalid')}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor={`limit-monthly-${subjectId}`}>
              {t('budgets.monthlyLimit', { unit: unitWord })}
            </FieldLabel>
            <Input
              id={`limit-monthly-${subjectId}`}
              inputMode="decimal"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
              placeholder={t('budgets.noLimitPlaceholder')}
              aria-invalid={!monthlyInput.ok || undefined}
            />
            {!monthlyInput.ok && <FieldError>{t('budgets.limitInvalid')}</FieldError>}
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy || !limitsValid}>
            {tCommon('actions.save')}
          </Button>
          {current && (
            <Button variant="ghost" onClick={remove} disabled={busy}>
              <Trash2 className="mr-1 size-3.5" aria-hidden />
              {t('budgets.removePolicy')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
