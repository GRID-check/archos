'use client'

import type { JSX, KeyboardEvent } from 'react'
import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DateInput } from '@/components/ui/date-input'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useLocale, useTranslations } from '@/i18n'
import { DOSSIER_FACT_KEYS, type DossierFactKey } from '@/lib/documents/dossier'
import type { DocumentFilters } from '@/lib/search/search-wire'
import { useSearchLabels } from '../hooks/use-search-labels'
import { splitList } from '../lib/active-filters'
import { compactFilters, NUMERIC_FACT_KEYS, type SearchUrlState } from '../lib/search-url'
import { FieldPair, FieldStack, KeyFieldRow, RailAction, RailBody, RailSection } from './search-atoms'

export interface SearchFilterFormProps {
  state: SearchUrlState
  onChange: (next: SearchUrlState) => void
  /** Offers „Von mir hochgeladen“ when known. */
  currentUserId?: string
  /** Open from the start (the preview, a phone that asked for filters). */
  defaultOpen?: boolean
}

function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim().replace(',', '.')
  if (trimmed === '') return undefined
  const number = Number(trimmed)
  return Number.isFinite(number) ? number : undefined
}

/**
 * The three filters a drawing is found by in the Jour fixe: Plannummer, Index
 * and „Nur aktuelle Fassung“. The rail's first group, always open, because
 * they are typed rather than counted and are what an office reaches for first.
 */
export function SearchKeyFilters({ state, onChange }: Pick<SearchFilterFormProps, 'state' | 'onChange'>): JSX.Element {
  const t = useTranslations('search.filters')
  const f = state.filters
  const set = (patch: Partial<DocumentFilters>): void => onChange({ ...state, filters: compactFilters({ ...f, ...patch }) })
  return (
    <RailSection title={t('keyTitle')} fixed testId="search-key-filters">
      <RailBody>
        {/* Two short codes, one row: the Index is a letter or two. Their example is the placeholder, not a hint line under each. */}
        <KeyFieldRow>
          <CommitText
            label={t('planNumber')}
            placeholder={t('planNumberPlaceholder')}
            value={f.planNumber ?? ''}
            onCommit={(value) => set({ planNumber: value || undefined })}
            testId="filter-plan-number"
          />
          <CommitText
            label={t('planIndex')}
            placeholder={t('planIndexPlaceholder')}
            title={t('listHint')}
            value={(f.planIndex ?? []).join(', ')}
            onCommit={(value) => set({ planIndex: splitList(value) })}
            testId="filter-plan-index"
          />
        </KeyFieldRow>
        {/* The register says it above its table (`SearchRegisterBar`): one control per view for one setting. */}
        {state.view === 'register' ? null : (
          <Flag label={t('currentOnly')} checked={Boolean(f.currentOnly)} onChange={(on) => set({ currentOnly: on || undefined })} testId="filter-current" />
        )}
      </RailBody>
    </RailSection>
  )
}

/**
 * The rest of the structured filters of `DocumentFilters` that are typed
 * rather than counted: Planstand, Maßstab, Ort, Angaben, Hochgeladen, Seiten.
 * What the rail counts (Beteiligte, Verweist auf, Dateityp) is chosen in its
 * facet group and nowhere else, so no filter has two controls; a party's name,
 * which no count lists, is typed inside the Beteiligte group
 * (`PartyNameFilter`). Folded under „Weitere Filter“: they are
 * reached for less, and a rail that shows them all buries the counts. A typed
 * field takes effect on Enter or when it loses focus, so the search does not
 * run on every keystroke of a number.
 */
export function SearchFilterForm({ state, onChange, currentUserId, defaultOpen = false }: SearchFilterFormProps): JSX.Element {
  const t = useTranslations('search.filters')
  const f = state.filters
  const set = (patch: Partial<DocumentFilters>): void => onChange({ ...state, filters: compactFilters({ ...f, ...patch }) })

  return (
    <RailSection title={t('title')} defaultOpen={defaultOpen} testId="search-more-filters">
      <RailBody>
        <DateRange label={t('planDate')} value={f.planDate} onChange={(range) => set({ planDate: range })} testId="filter-plan-date" />
        <CommitText
          label={t('scale')}
          hint={t('listHint')}
          value={(f.scale ?? []).join(', ')}
          onCommit={(value) => set({ scale: splitList(value) })}
          testId="filter-scale"
        />
        <CommitText label={t('place')} hint={t('placeHint')} value={f.place ?? ''} onCommit={(value) => set({ place: value || undefined })} testId="filter-place" />
        <FactAdder onAdd={(fact) => set({ facts: [...(f.facts ?? []), fact] })} />
        <DateRange label={t('uploaded')} value={f.uploaded} onChange={(range) => set({ uploaded: range })} testId="filter-uploaded" />
        {currentUserId ? (
          <Flag
            label={t('uploadedByMe')}
            checked={(f.uploadedBy ?? []).includes(currentUserId)}
            onChange={(on) =>
              set({ uploadedBy: on ? [...new Set([...(f.uploadedBy ?? []), currentUserId])] : (f.uploadedBy ?? []).filter((id) => id !== currentUserId) })
            }
            testId="filter-uploaded-by-me"
          />
        ) : null}
        <NumberRange
          label={t('pages')}
          min={f.pages?.min}
          max={f.pages?.max}
          onChange={(min, max) =>
            set({
              pages:
                min === undefined && max === undefined
                  ? undefined
                  : { ...(min !== undefined ? { min: Math.max(0, Math.trunc(min)) } : {}), ...(max !== undefined ? { max: Math.max(0, Math.trunc(max)) } : {}) },
            })
          }
        />
        <Flag label={t('incompleteRead')} checked={Boolean(f.incompleteRead)} onChange={(on) => set({ incompleteRead: on || undefined })} testId="filter-incomplete" />
        <Flag label={t('includeArchived')} checked={Boolean(f.includeArchived)} onChange={(on) => set({ includeArchived: on || undefined })} testId="filter-archived" />
      </RailBody>
    </RailSection>
  )
}

/** A text field that takes effect on Enter or blur, keyed to its committed value so the URL resets it. */
function CommitText(props: {
  label: string
  hint?: string
  placeholder?: string
  title?: string
  value: string
  onCommit: (value: string) => void
  clearOnCommit?: boolean
  testId?: string
}): JSX.Element {
  return <CommitTextField key={props.value} {...props} />
}

function CommitTextField({
  label,
  hint,
  placeholder,
  title,
  value,
  onCommit,
  clearOnCommit = false,
  testId,
}: {
  label: string
  hint?: string
  placeholder?: string
  title?: string
  value: string
  onCommit: (value: string) => void
  clearOnCommit?: boolean
  testId?: string
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const commit = (): void => {
    const next = draft.trim()
    if (next === value) return
    onCommit(next)
    if (clearOnCommit) setDraft('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    }
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={draft}
        placeholder={placeholder}
        title={title}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        data-testid={testId}
      />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  )
}

function DateRange({
  label,
  value,
  onChange,
  testId,
}: {
  label: string
  value: { from?: string; to?: string } | undefined
  onChange: (range: { from?: string; to?: string } | undefined) => void
  testId?: string
}): JSX.Element {
  const t = useTranslations('search.filters')
  const { locale } = useLocale()
  const id = useId()
  const tokens = { day: t('dateTokens.day'), month: t('dateTokens.month'), year: t('dateTokens.year') }
  const change = (patch: { from?: string; to?: string }): void => {
    const next = { ...value, ...patch }
    const from = next.from || undefined
    const to = next.to || undefined
    onChange(from === undefined && to === undefined ? undefined : { ...(from ? { from } : {}), ...(to ? { to } : {}) })
  }
  return (
    <Field>
      <FieldLabel htmlFor={`${id}-from`}>{label}</FieldLabel>
      <FieldStack>
        <DateInput
          id={`${id}-from`}
          locale={locale}
          tokens={tokens}
          placeholderPrefix={t('from')}
          aria-label={`${label} ${t('from')}`}
          value={value?.from ?? ''}
          max={value?.to}
          onChange={(from) => change({ from })}
          data-testid={testId ? `${testId}-from` : undefined}
        />
        <DateInput
          locale={locale}
          tokens={tokens}
          placeholderPrefix={t('to')}
          aria-label={`${label} ${t('to')}`}
          value={value?.to ?? ''}
          min={value?.from}
          onChange={(to) => change({ to })}
          data-testid={testId ? `${testId}-to` : undefined}
        />
      </FieldStack>
    </Field>
  )
}

function NumberRange({
  label,
  min,
  max,
  onChange,
}: {
  label: string
  min: number | undefined
  max: number | undefined
  onChange: (min: number | undefined, max: number | undefined) => void
}): JSX.Element {
  const t = useTranslations('search.filters')
  const id = useId()
  const [draftMin, setDraftMin] = useState(min === undefined ? '' : String(min))
  const [draftMax, setDraftMax] = useState(max === undefined ? '' : String(max))
  const nextMin = numberOrUndefined(draftMin)
  const nextMax = numberOrUndefined(draftMax)
  // A range that ends before it starts finds nothing: it is marked, not sent.
  const invalid = nextMin !== undefined && nextMax !== undefined && nextMin > nextMax
  const commit = (): void => {
    if (invalid) return
    if (nextMin !== min || nextMax !== max) onChange(nextMin, nextMax)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') commit()
  }
  return (
    <Field>
      <FieldLabel htmlFor={`${id}-min`}>{label}</FieldLabel>
      <FieldPair>
        <Input id={`${id}-min`} inputMode="decimal" placeholder={t('min')} aria-label={`${label} ${t('min')}`} value={draftMin} onChange={(event) => setDraftMin(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
        <Input inputMode="decimal" placeholder={t('max')} aria-label={`${label} ${t('max')}`} aria-invalid={invalid || undefined} value={draftMax} onChange={(event) => setDraftMax(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
      </FieldPair>
      {invalid ? <FieldError>{t('rangeInvalid')}</FieldError> : null}
    </Field>
  )
}

function Flag({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange: (on: boolean) => void; testId?: string }): JSX.Element {
  const id = useId()
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Switch id={id} checked={checked} onCheckedChange={onChange} data-testid={testId} />
    </Field>
  )
}

/**
 * A party by name, inside the Beteiligte group: the roles are counted there,
 * a name is typed. Enter adds it as a chip and empties the field for the next.
 */
export function PartyNameFilter({ state, onChange }: Pick<SearchFilterFormProps, 'state' | 'onChange'>): JSX.Element {
  const t = useTranslations('search.filters')
  const f = state.filters
  return (
    <RailBody>
      <CommitText
        label={t('partyNameLabel')}
        placeholder={t('partyNamePlaceholder')}
        value=""
        clearOnCommit
        onCommit={(value) => {
          if (value) onChange({ ...state, filters: compactFilters({ ...f, parties: [...(f.parties ?? []), { name: value.slice(0, 120) }] }) })
        }}
        testId="filter-party-name"
      />
    </RailBody>
  )
}

function FactAdder({ onAdd }: { onAdd: (fact: { key: DossierFactKey; equals?: string; min?: number; max?: number }) => void }): JSX.Element {
  const t = useTranslations('search.filters')
  const labels = useSearchLabels()
  const id = useId()
  const [key, setKey] = useState<DossierFactKey>('building_class')
  const [equals, setEquals] = useState('')
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const numeric = NUMERIC_FACT_KEYS.has(key)
  const lower = numberOrUndefined(min)
  const upper = numberOrUndefined(max)
  const inverted = lower !== undefined && upper !== undefined && lower > upper
  const ready = numeric ? !inverted && (lower !== undefined || upper !== undefined) : equals.trim() !== ''
  const add = (): void => {
    if (!ready) return
    const value = equals.trim()
    onAdd(numeric ? { key, ...(lower !== undefined ? { min: lower } : {}), ...(upper !== undefined ? { max: upper } : {}) } : { key, equals: value.slice(0, 120) })
    setEquals('')
    setMin('')
    setMax('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') add()
  }
  return (
    <Field>
      <FieldLabel htmlFor={`${id}-key`}>{t('fact')}</FieldLabel>
      <Select value={key} onValueChange={(value) => setKey(value as DossierFactKey)}>
        <SelectTrigger id={`${id}-key`} aria-label={t('factKey')} data-testid="filter-fact-key">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DOSSIER_FACT_KEYS.map((value) => (
            <SelectItem key={value} value={value}>
              {labels.factKey(value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {numeric ? (
        <FieldPair>
          <Input inputMode="decimal" placeholder={t('min')} aria-label={t('min')} value={min} onChange={(event) => setMin(event.target.value)} onKeyDown={onKeyDown} data-testid="filter-fact-min" />
          <Input inputMode="decimal" placeholder={t('max')} aria-label={t('max')} value={max} onChange={(event) => setMax(event.target.value)} onKeyDown={onKeyDown} data-testid="filter-fact-max" />
        </FieldPair>
      ) : (
        <Input placeholder={t('factValue')} aria-label={t('factValue')} value={equals} onChange={(event) => setEquals(event.target.value)} onKeyDown={onKeyDown} data-testid="filter-fact-value" />
      )}
      {inverted ? <FieldError>{t('rangeInvalid')}</FieldError> : null}
      <RailAction>
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={!ready} data-testid="filter-fact-add">
          {t('add')}
        </Button>
      </RailAction>
    </Field>
  )
}
