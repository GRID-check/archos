'use client'

/**
 * The address of a new project: one text field that keeps what the person
 * types. Where an address search is configured it also suggests hits
 * (`createGeocodingClient().search`), and choosing one adds what the hit knows
 * (Gemeinde, Bundesland, the position). Not choosing one loses nothing: the
 * typed line is the address, and Piloti finds the Bundesland in the documents
 * or asks for it in the review.
 *
 * The field never changes into something else. It used to turn into a
 * Bundesland select on the first answer saying no search was configured, which
 * is every deployment without `GEOCODER_URL`: the person typed three
 * letters and their text was gone (pilot onboarding, 2026-10-19).
 *
 * Typing asks after 250 ms of quiet; every keystroke aborts the request still
 * in flight, so a slow answer for „Haupt" never lands over the one for
 * „Hauptstraße 1". The suggestions float over the form below rather than
 * pushing it down, but are not portalled: a portal in a dialog fights the
 * dialog over focus, outside presses and Escape. It is the ARIA combobox
 * pattern (focus stays in the field; arrows move `aria-activedescendant`;
 * Enter chooses; Escape closes the list and nothing else).
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { MapPin } from 'lucide-react'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Listbox, ListboxOption } from '@/components/ui/listbox'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { projectsCopy } from '@/i18n/namespaces/projects'
import { createGeocodingClient, type GeocodingClient } from '@/lib/geocoding/client'
import { GEOCODE_DEFAULT_LIMIT, type GeocodeResult } from '@/lib/geocoding/types'
import { MAX_ADDRESS_LENGTH } from '@/lib/projects/create-project-schema'
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

/** What the field holds: the line as typed, and the hit it came from when one was chosen. */
export interface AddressValue {
  text: string
  place: GeocodeResult | null
}

export interface AddressFieldProps {
  value: AddressValue
  onChange: (value: AddressValue) => void
  disabled?: boolean
  /** The address search; the real one unless a spec brings its own. */
  client?: GeocodingClient
  sameAddressClient?: SameAddressClient
}

export function AddressField({
  value,
  onChange,
  disabled = false,
  client,
  sameAddressClient,
}: AddressFieldProps): JSX.Element {
  const t = useTranslations(projectsCopy)
  const id = useId()
  const listId = `${id}-list`
  const geocoder = useRef<GeocodingClient>(client ?? createGeocodingClient())
  const sameAddress = useRef<SameAddressClient>(sameAddressClient ?? createSameAddressClient())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef<AbortController | null>(null)

  const [searchOff, setSearchOff] = useState(geocoderKnownOff)
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

  const search = useCallback(async (query: string) => {
    const controller = new AbortController()
    inFlight.current = controller
    setStatus('searching')
    try {
      const answer = await geocoder.current.search(query, GEOCODE_DEFAULT_LIMIT, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (!answer.enabled) {
        // No search here: the field stays a text field and stops asking.
        geocoderKnownOff = true
        setSearchOff(true)
        setResults([])
        setStatus('idle')
        return
      }
      setResults(answer.results)
      setActive(answer.results.length > 0 ? 0 : -1)
      setStatus('done')
    } catch {
      // A failed search is no suggestions; the typed line stays the address.
      if (controller.signal.aborted) return
      setResults([])
      setStatus('done')
    }
  }, [])

  const onInput = (next: string): void => {
    cancel()
    // Editing the line lets go of the hit it came from: the two would disagree.
    onChange({ text: next, place: null })
    setActive(-1)
    if (searchOff || next.trim().length < MIN_QUERY_LENGTH) {
      setResults([])
      setStatus('idle')
      return
    }
    setOpen(true)
    setStatus('waiting')
    timer.current = setTimeout(() => void search(next.trim()), ADDRESS_SEARCH_DEBOUNCE_MS)
  }

  const choose = (place: GeocodeResult): void => {
    cancel()
    onChange({ text: place.label, place })
    setResults([])
    setStatus('idle')
    setOpen(false)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && open && results.length > 0) {
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
  const searching = status === 'waiting' || status === 'searching'
  const chosen = value.place

  return (
    <Field>
      <FieldLabel htmlFor={`${id}-input`}>{t('form.addressLabel')}</FieldLabel>
      <div className="relative">
        <Input
          id={`${id}-input`}
          role={searchOff ? undefined : 'combobox'}
          aria-label={t('form.addressLabel')}
          aria-expanded={searchOff ? undefined : listed}
          aria-controls={searchOff ? undefined : listId}
          aria-autocomplete={searchOff ? undefined : 'list'}
          aria-activedescendant={listed && active >= 0 ? `${id}-option-${active}` : undefined}
          autoComplete="street-address"
          value={value.text}
          maxLength={MAX_ADDRESS_LENGTH}
          placeholder={t('form.addressPlaceholder')}
          disabled={disabled}
          onChange={(event) => onInput(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          data-testid="create-project-address"
        />
        {searching && (
          <Spinner className="absolute top-1/2 right-3 size-4 -translate-y-1/2" aria-label={t('form.address.searching')} />
        )}
        {listed && (
          // One floating panel: the hits, and under them the reminder that
          // none has to be chosen. The reminder sits outside the listbox,
          // which may hold options only.
          <div
            className="bg-popover text-popover-foreground border-border absolute inset-x-0 top-full z-20 mt-1.5 rounded-surface border p-1 shadow-lg"
            data-testid="create-project-address-suggestions"
          >
            <Listbox
              id={listId}
              aria-label={t('form.address.suggestions')}
              className="rounded-none border-0 p-0 shadow-none"
            >
              {results.map((place, index) => (
                <ListboxOption
                  key={`${place.label}-${place.lat}-${place.lon}`}
                  id={`${id}-option-${index}`}
                  active={index === active}
                  onChoose={() => choose(place)}
                  className="flex-row items-center justify-start gap-2.5 py-2"
                >
                  <MapPin className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{place.label}</span>
                    {placeLine(place) && (
                      <span className="text-muted-foreground truncate text-xs">{placeLine(place)}</span>
                    )}
                  </span>
                </ListboxOption>
              ))}
            </Listbox>
            <p className="text-muted-foreground border-border mt-1 border-t px-2.5 pt-2 pb-1.5 text-xs">
              {t('form.address.keepTyped')}
            </p>
          </div>
        )}
      </div>
      {chosen && placeLine(chosen) && (
        <FieldDescription className="flex items-center gap-1.5" data-testid="create-project-address-place">
          <MapPin className="size-3.5 shrink-0" aria-hidden />
          {placeLine(chosen)}
        </FieldDescription>
      )}
      {chosen && <SameAddressNotice place={chosen} client={sameAddress.current} />}
    </Field>
  )
}
