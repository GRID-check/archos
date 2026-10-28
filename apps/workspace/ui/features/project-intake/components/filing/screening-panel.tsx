'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import { ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react'
import { toast } from 'sonner'
import type { ProjectUploadScreeningState } from '@/adapters/api/project-upload-screening-client'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { TagInput } from '@/components/ui/tag-input'
import { useLocale, useTranslations, type Translator } from '@/i18n'
import { intakeFilingStepCopy } from '@/i18n/namespaces/intake-filing-step'
import { normalizeTermList } from '@/lib/upload-screening/policy'
import type { ProjectScreeningOverride } from '@/lib/upload-screening/project-policy'
import { SummaryBlock } from './filing-atoms'
import type { ScreeningPreview } from './folder-tree'

export interface ScreeningSummaryProps {
  /** The project's list; null while it loads or when it could not be read. */
  screening: ProjectUploadScreeningState | null
  loadFailed: boolean
  onRetry: () => void
  /** What the list holds back of the current choice; null without a choice. */
  preview: ScreeningPreview | null
  /** The draft being edited, so the tree shows its effect before it is saved. */
  draft: ProjectScreeningOverride | null
  onDraftChange: (draft: ProjectScreeningOverride | null) => void
  onSave: (override: ProjectScreeningOverride) => Promise<boolean>
}

const key = (term: string): string => term.toLocaleLowerCase('de')

/** Which list this is, in a sentence: the office's, Piloti's suggestion, or the project's own. */
function listName(screening: ProjectUploadScreeningState, t: Translator): string {
  const { override } = screening
  if (override.addedNameTerms.length + override.removedNameTerms.length > 0) return t('screening.listProject')
  return screening.officeSuggested ? t('screening.listSuggested') : t('screening.listOffice')
}

/**
 * Sensible Daten, as one block of the summary card: what the office's list
 * keeps on the server of the choice and on which terms, and (for whoever
 * manages the project) „Für dieses Projekt anpassen", which opens the list for
 * this project only in a sheet: an office term switched off here, or a term
 * added here. A draft shows its effect in the tree and the sheet before it is
 * saved (ADR-0086, 2026-10-20).
 */
export function ScreeningSummary(props: ScreeningSummaryProps): JSX.Element {
  const { screening, loadFailed, onRetry, preview, draft, onDraftChange } = props
  const t = useTranslations(intakeFilingStepCopy)
  const { locale } = useLocale()

  if (loadFailed) {
    return (
      <SummaryBlock
        testId="filing-screening"
        icon={<ShieldAlert className="text-destructive" aria-hidden />}
        title={t('screening.heading')}
        body={t('screening.loadError')}
        action={
          <Button type="button" variant="inline" onClick={onRetry}>
            {t('screening.retry')}
          </Button>
        }
      />
    )
  }
  if (!screening) {
    return (
      <SummaryBlock
        testId="filing-screening"
        icon={<ShieldCheck className="text-muted-foreground" aria-hidden />}
        title={t('screening.heading')}
        body={t('screening.loading')}
      />
    )
  }
  if (!screening.office.enabled) {
    return (
      <SummaryBlock
        testId="filing-screening"
        icon={<ShieldOff className="text-muted-foreground" aria-hidden />}
        title={t('screening.offTitle')}
        body={t('screening.off')}
      />
    )
  }

  const list = listName(screening, t)
  const terms = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
    (preview?.byTerm ?? []).map((entry) => t('screening.term', { term: entry.term }))
  )
  const held = preview?.held.length ?? 0
  const title = !preview ? t('screening.aheadTitle') : held > 0 ? t('screening.heldTitle', { count: held }) : t('screening.noneTitle')
  const body = !preview ? t('screening.ahead', { list }) : held > 0 ? t('screening.because', { terms, list }) : t('screening.none', { list })

  return (
    <>
      <SummaryBlock
        testId="filing-screening"
        icon={<ShieldCheck className={held > 0 ? 'text-warning' : 'text-muted-foreground'} aria-hidden />}
        title={<span data-testid="filing-held">{title}</span>}
        body={body}
        action={
          screening.canManage ? (
            <Button type="button" variant="inline" onClick={() => onDraftChange(screening.override)}>
              {t('screening.adjust')}
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs">{t('screening.readOnly')}</span>
          )
        }
      />
      <ScreeningEditor {...props} screening={screening} open={draft !== null} />
    </>
  )
}

/** The list for this project, in a sheet: the office's terms switched per project, and terms of its own. */
function ScreeningEditor({
  screening,
  preview,
  draft,
  onDraftChange,
  onSave,
  open,
}: ScreeningSummaryProps & { screening: ProjectUploadScreeningState; open: boolean }): JSX.Element {
  const t = useTranslations(intakeFilingStepCopy)
  const [saving, setSaving] = useState(false)
  const { office, override } = screening
  const current = draft ?? override
  const removed = new Set(current.removedNameTerms.map(key))

  const toggleOfficeTerm = (term: string): void => {
    const removedNameTerms = removed.has(key(term))
      ? current.removedNameTerms.filter((entry) => key(entry) !== key(term))
      : [...current.removedNameTerms, term]
    onDraftChange({ ...current, removedNameTerms })
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    const ok = await onSave(draft)
    setSaving(false)
    if (ok) {
      onDraftChange(null)
      toast.success(t('screening.saved'))
    } else {
      toast.error(t('screening.saveError'))
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onDraftChange(null)}>
      <SheetContent side="right" closeLabel={t('screening.close')} data-testid="filing-screening-editor">
        <SheetHeader>
          <SheetTitle>{t('screening.heading')}</SheetTitle>
          <SheetDescription>{t('screening.description')}</SheetDescription>
        </SheetHeader>
        {preview && (
          <p className="bg-muted/60 rounded-lg px-3 py-2 text-sm" role="status" data-testid="filing-screening-preview">
            {preview.held.length > 0
              ? t('screening.preview', { count: preview.held.length })
              : t('screening.previewNone')}
          </p>
        )}
        <Field>
          <FieldLabel>{t('screening.officeTerms')}</FieldLabel>
          <FieldDescription>{t('screening.officeTermsHint')}</FieldDescription>
          <ul className="flex flex-wrap gap-2">
            {office.nameTerms.map((term) => {
              const on = !removed.has(key(term))
              return (
                <li key={term}>
                  <Chip asChild interactive variant={on ? 'secondary' : 'outline'} size="md">
                    <button
                      type="button"
                      aria-pressed={on}
                      aria-label={t(on ? 'screening.termOn' : 'screening.termOff', { term })}
                      className={on ? undefined : 'text-muted-foreground line-through'}
                      onClick={() => toggleOfficeTerm(term)}
                    >
                      {term}
                    </button>
                  </Chip>
                </li>
              )
            })}
          </ul>
        </Field>
        <Field>
          <FieldLabel htmlFor="filing-added-terms">{t('screening.added')}</FieldLabel>
          <TagInput
            id="filing-added-terms"
            value={current.addedNameTerms}
            onChange={(addedNameTerms) => onDraftChange({ ...current, addedNameTerms })}
            normalize={normalizeTermList}
            removeLabel={(term) => t('screening.removeTerm', { term })}
            placeholder={t('screening.addedPlaceholder')}
            aria-label={t('screening.added')}
          />
        </Field>
        <p className="text-muted-foreground text-xs">{t('screening.contentNote')}</p>
        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onDraftChange(null)}>
            {t('screening.cancel')}
          </Button>
          <BusyButton type="button" busy={saving} busyLabel={t('screening.saving')} onClick={() => void save()}>
            {t('screening.save')}
          </BusyButton>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
