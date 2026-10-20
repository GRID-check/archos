'use client'

/**
 * The address of a new project: a combobox over the address search
 * (`createGeocodingClient().search`), and when no geocoder is configured, the
 * Bundesland chosen by hand, which is all the address was for.
 *
 * Typing asks after 250 ms of quiet. Every keystroke aborts the request still
 * in flight, so a slow answer for „Haupt" never lands over the one for
 * „Hauptstraße 1". The list is the ARIA combobox pattern (focus stays in the
 * field; arrows move `aria-activedescendant`; Enter chooses; Escape closes the
 * list and nothing else, so it does not close the dialog around it).
 *
 * Whether a geocoder exists is only known from an answer (`enabled: false`), so
 * the field starts as the combobox and, on that answer, becomes the Bundesland
 * select. The answer is remembered for the page's life, so the next dialog
 * opens as the select at once.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { MapPin, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Listbox, ListboxOption } from '@/components/ui/listbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { createGeocodingClient, type GeocodingClient } from '@/lib/geocoding/client'
import { GEOCODE_DEFAULT_LIMIT, type GeocodeResult } from '@/lib/geocoding/types'
import { FEDERAL_STATE_OPTIONS } from '@/lib/projects/federal-state-options'
import { createSameAddressClient, type SameAddressClient } from '@/lib/projects/same-address-client'
import { SameAddressNotice } from './same-address-notice'

/** Quiet time before a keystroke becomes a request. */
export const ADDRESS_SEARCH_DEBOUNCE_MS = 250
/** Shortest text the address search takes (`geocodeQuerySchema`). */
const MIN_QUERY_LENGTH = 3

/** The geocoder answered `enabled: false` once; the page asks no more. */
let geocoderKnownOff = false

/** For specs: forget what an earlier answer taught the field. */
export function forgetGeocoderAnswer(): void {
  geocoderKnownOff = false
}

type SearchStatus = 'idle' | 'waiting' | 'searching' | 'done'

/** „Gemeinde · Bundesland" of a hit, as far as the provider named them. */
export function placeLine(place: Pick<GeocodeResult, 'municipality' | 'state'>): string {
  return [place.municipality, place.state].filter(Boolean).join(' · ')
}

export interface AddressFieldProps {
  value: GeocodeResult | null
  onChange: (value: GeocodeResult | null) => void
  /** The Bundesland chosen by hand, used while there is no geocoder. */
  federalState: string
  onFederalStateChange: (value: string) => void
  disabled?: boolean
  /** The address search; the real one unless a spec brings its own. */
  client?: GeocodingClient
  sameAddressClient?: SameAddressClient
}

export function AddressField({
  value,
  onChange,
  federalState,
  onFederalStateChange,
  disabled = false,
  client,
  sameAddressClient,
}: AddressFieldProps): JSX.Element {
  const t = useTranslations('projects')
  const [off, setOff] = useState(geocoderKnownOff)

  if (off) {
    return (
      <Field>
        <FieldLabel htmlFor="create-project-federal-state">{t('form.federalStateLabel')}</FieldLabel>
        <Select value={federalState} onValueChange={onFederalStateChange} disabled={disabled}>
          <SelectTrigger id="create-project-federal-state" className="w-full">
            <SelectValue placeholder={t('form.federalStatePlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {FEDERAL_STATE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{t('form.federalStateHelp')}</FieldDescription>
      </Field>
    )
  }

  return (
    <AddressCombobox
      value={value}
      onChange={onChange}
      disabled={disabled}
      client={client}
      sameAddressClient={sameAddressClient}
      onGeocoderOff={() => {
        geocoderKnownOff = true
        setOff(true)
      }}
    />
  )
}

function AddressCombobox({
  value,
  onChange,
  disabled,
  client,
  sameAddressClient,
  onGeocoderOff,
}: Pick<AddressFieldProps, 'value' | 'onChange' | 'disabled' | 'client' | 'sameAddressClient'> & {
  onGeocoderOff: () => void
}): JSX.Element {
  const t = useTranslations('projects')
  const id = useId()
  const listId = `${id}-list`
  const inputRef = useRef<HTMLInputElement>(null)
  const geocoder = useRef<GeocodingClient>(client ?? createGeocodingClient())
  const sameAddress = useRef<SameAddressClient>(sameAddressClient ?? createSameAddressClient())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef<AbortController | null>(null)

  const [text, setText] = useState('')
  const [results, setResults] = useState<GeocodeResult[]>([])
  const [status, setStatus] = useState<SearchStatus>('idle')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    inFlight.current?.abort()
    inFlight.current = null
  }, [])
  useEffect(() => cancel, [cancel])

  const search = useCallback(
    async (query: string) => {
      const controller = new AbortController()
      inFlight.current = controller
      setStatus('searching')
      try {
        const answer = await geocoder.current.search(query, GEOCODE_DEFAULT_LIMIT, { signal: controller.signal })
        if (controller.signal.aborted) return
        if (!answer.enabled) return onGeocoderOff()
        setResults(answer.results)
        setActive(answer.results.length > 0 ? 0 : -1)
        setStatus('done')
      } catch {
        // An aborted or failed search leaves the field as it was: the person
        // keeps typing, and the address can be added later.
        if (controller.signal.aborted) return
        setResults([])
        setStatus('done')
      }
    },
    [onGeocoderOff]
  )

  const onInput = (next: string): void => {
    cancel()
    setText(next)
    setOpen(true)
    setActive(-1)
    if (next.trim().length < MIN_QUERY_LENGTH) {
      setResults([])
      setStatus('idle')
      return
    }
    setStatus('waiting')
    timer.current = setTimeout(() => void search(next.trim()), ADDRESS_SEARCH_DEBOUNCE_MS)
  }

  const choose = (place: GeocodeResult): void => {
    cancel()
    onChange(place)
    setText('')
    setResults([])
    setStatus('idle')
    setOpen(false)
  }

  const clear = (): void => {
    onChange(null)
    // The input comes back on the next render; focus follows it.
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && open) {
      // The list closes; the dialog around it stays.
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (results.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActive((index) => (index + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActive((index) => (index <= 0 ? results.length - 1 : index - 1))
    } else if (event.key === 'Enter' && open && active >= 0) {
      // Not a form submit: choosing an option is not creating the project.
      event.preventDefault()
      choose(results[active])
    }
  }

  const listed = open && results.length > 0
  const none = open && status === 'done' && results.length === 0

  if (value) {
    return (
      <Field>
        <FieldLabel id={`${id}-label`}>{t('form.addressLabel')}</FieldLabel>
        <div
          className="bg-card border-border flex items-center gap-3 rounded-lg border px-3.5 py-2"
          data-testid="create-project-address-chosen"
        >
          <MapPin className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{value.label}</p>
            {placeLine(value) && <p className="text-muted-foreground truncate text-xs">{placeLine(value)}</p>}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={clear}
            disabled={disabled}
            aria-label={t('form.address.change')}
            title={t('form.address.change')}
          >
            <X aria-hidden />
          </Button>
        </div>
        <SameAddressNotice place={value} client={sameAddress.current} />
      </Field>
    )
  }

  return (
    <Field>
      <FieldLabel htmlFor={`${id}-input`}>
        {t('form.addressLabel')}
        <span className="text-muted-foreground font-normal">({t('form.closed.optional')})</span>
      </FieldLabel>
      <div className="relative">
        <Input
          ref={inputRef}
          id={`${id}-input`}
          role="combobox"
          aria-label={t('form.addressLabel')}
          aria-expanded={listed}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={listed && active >= 0 ? `${id}-option-${active}` : undefined}
          autoComplete="off"
          value={text}
          placeholder={t('form.addressPlaceholder')}
          disabled={disabled}
          onChange={(event) => onInput(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {(status === 'waiting' || status === 'searching') && (
          <Spinner className="absolute top-1/2 right-3 size-4 -translate-y-1/2" aria-label={t('form.address.searching')} />
        )}
      </div>
      {listed && (
        <Listbox id={listId} aria-label={t('form.address.suggestions')} className="mt-1">
          {results.map((place, index) => (
            <ListboxOption
              key={`${place.label}-${place.lat}-${place.lon}`}
              id={`${id}-option-${index}`}
              active={index === active}
              onChoose={() => choose(place)}
            >
              <span className="truncate">{place.label}</span>
              {placeLine(place) && <span className="text-muted-foreground truncate text-xs">{placeLine(place)}</span>}
            </ListboxOption>
          ))}
        </Listbox>
      )}
      {none && (
        <p role="status" className="text-muted-foreground text-xs">
          {t('form.address.none')}
        </p>
      )}
      <FieldDescription>{t('form.addressHelp')}</FieldDescription>
    </Field>
  )
}
