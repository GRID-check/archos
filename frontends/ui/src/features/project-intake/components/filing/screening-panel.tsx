'use client'

import type { JSX } from 'react'
import { useState } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { ProjectUploadScreeningState } from '@/adapters/api/project-upload-screening-client'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { TagInput } from '@/components/ui/tag-input'
import { useTranslations } from '@/i18n'
import { normalizeTermList } from '@/lib/upload-screening/policy'
import type { ProjectScreeningOverride } from '@/lib/upload-screening/project-policy'
import { IntakeSection } from '../intake-atoms'
import type { ScreeningPreview } from './folder-tree'

export interface ScreeningPanelProps {
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

/**
 * Sensible Daten for this project: what the office's list holds back of the
 * choice and which rule holds it, and (for whoever manages the project) the
 * list changed for this project only: an office term switched off here, or a
 * term added here. A draft shows its effect in the tree before it is saved.
 */
export function ScreeningPanel({
  screening,
  loadFailed,
  onRetry,
  preview,
  draft,
  onDraftChange,
  onSave,
}: ScreeningPanelProps): JSX.Element | null {
  const t = useTranslations('intakeFilingStep')
  const [saving, setSaving] = useState(false)

  if (loadFailed) {
    return (
      <IntakeSection label={t('screening.heading')} testId="filing-screening">
        <Alert variant="destructive">
          <AlertDescription className="text-current">
            <p>{t('screening.loadError')}</p>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              <RefreshCw aria-hidden />
              {t('screening.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      </IntakeSection>
    )
  }
  // Still loading: nothing to say yet, and the upload waits for it.
  if (!screening) return null

  const { office, override } = screening
  const editing = draft !== null
  const current = draft ?? override
  const removed = new Set(current.removedNameTerms.map(key))
  const changed = override.addedNameTerms.length + override.removedNameTerms.length > 0

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
    <IntakeSection
      label={t('screening.heading')}
      description={t('screening.description')}
      testId="filing-screening"
      action={
        screening.canManage && !editing ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onDraftChange(override)}>
            {t('screening.change')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <ShieldCheck className="text-muted-foreground size-4" aria-hidden />
        <span>{screening.officeSuggested ? t('screening.officeSuggested') : t('screening.officeList')}</span>
        {changed && <Badge variant="info">{t('screening.projectChanged')}</Badge>}
      </div>

      {!office.enabled ? (
        <p className="text-muted-foreground text-sm">{t('screening.off')}</p>
      ) : (
        preview && <HeldBack preview={preview} />
      )}

      {editing && office.enabled && (
        <div className="space-y-4 rounded-lg border p-4" data-testid="filing-screening-editor">
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
          <div className="flex flex-wrap gap-2">
            <BusyButton type="button" size="sm" busy={saving} busyLabel={t('screening.saving')} onClick={() => void save()}>
              {t('screening.save')}
            </BusyButton>
            <Button type="button" size="sm" variant="ghost" onClick={() => onDraftChange(null)}>
              {t('screening.cancel')}
            </Button>
          </div>
        </div>
      )}

      {!screening.canManage && office.enabled && <p className="text-muted-foreground text-xs">{t('screening.readOnly')}</p>}
    </IntakeSection>
  )
}

/** Per term, how many files of the choice it holds back, and where. */
function HeldBack({ preview }: { preview: ScreeningPreview }): JSX.Element {
  const t = useTranslations('intakeFilingStep')
  if (preview.held.length === 0) {
    return <p className="text-muted-foreground text-sm" data-testid="filing-held-none">{t('screening.heldNone')}</p>
  }
  return (
    <div className="space-y-2" data-testid="filing-held">
      <p className="text-sm font-medium">{t('screening.held', { count: preview.held.length })}</p>
      <ul className="space-y-1 text-sm">
        {preview.byTerm.map((entry) => (
          <li key={entry.term} data-testid="filing-held-term">
            <span className="font-medium">{t('screening.term', { term: entry.term })}</span>
            <span className="text-muted-foreground">
              {' · '}
              {t('screening.termFiles', { count: entry.files })}{' '}
              {t('screening.inFolders', {
                folders: [
                  ...entry.folders.slice(0, 3).map((folder) => folder || t('screening.topLevel')),
                  ...(entry.folders.length > 3 ? ['…'] : []),
                ].join(', '),
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
