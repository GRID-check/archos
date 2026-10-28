import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

import { render, screen, waitFor } from '@/test-utils'
import { I18nProvider } from '@/i18n'
import { SuggestSourceProvider, type SuggestSource } from '../hooks/use-filter-suggestions'
import { EMPTY_SEARCH_STATE } from '../lib/search-url'
import { PartyNameFilter, SearchFilterForm } from './search-filter-form'

function form(onChange = vi.fn()) {
  render(
    <I18nProvider initialLocale="de" fixedLocale>
      <SearchFilterForm state={EMPTY_SEARCH_STATE} onChange={onChange} defaultOpen />
    </I18nProvider>
  )
  return onChange
}

describe('completions from the documents', () => {
  const source = vi.fn<SuggestSource>(async (question) =>
    question.dimension === 'party'
      ? [{ value: 'Atelier Lindner ZT GmbH', label: 'Atelier Lindner ZT GmbH', count: 14 }]
      : question.dimension === 'scale'
        ? [
            { value: '1:100', label: '1:100', count: 9 },
            { value: '1:50', label: '1:50', count: 2 },
          ]
        : []
  )

  function withSource(children: ReactNode) {
    render(
      <I18nProvider initialLocale="de" fixedLocale>
        <SuggestSourceProvider value={source}>{children}</SuggestSourceProvider>
      </I18nProvider>
    )
  }

  it('offers the party names the office holds, with counts, and taking one adds it as typed by the documents', async () => {
    const onChange = vi.fn()
    withSource(<PartyNameFilter state={EMPTY_SEARCH_STATE} onChange={onChange} />)
    await userEvent.type(screen.getByTestId('filter-party-name'), 'lind')
    await waitFor(() => expect(source).toHaveBeenLastCalledWith({ dimension: 'party', prefix: 'lind' }, expect.any(AbortSignal)))
    const option = await screen.findByRole('option', { name: /Atelier Lindner ZT GmbH/ })
    expect(option).toHaveTextContent('14')
    await userEvent.click(option)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ filters: { parties: [{ name: 'Atelier Lindner ZT GmbH' }] } }))
  })

  it('completes the entry being typed in a list field, and leaves out the values already in it', async () => {
    const onChange = vi.fn()
    withSource(<SearchFilterForm state={EMPTY_SEARCH_STATE} onChange={onChange} defaultOpen />)
    await userEvent.type(screen.getByTestId('filter-scale'), '1:100, 1')
    const options = await screen.findAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['1:502'])
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ filters: { scale: ['1:100', '1:50'] } }))
  })
})

describe('SearchFilterForm', () => {
  it('shows an example in Maßstab and Ort, as the dates and the Plannummer do', () => {
    form()
    expect(screen.getByTestId('filter-scale')).toHaveAttribute('placeholder', '1:100, 1:50')
    expect(screen.getByTestId('filter-place')).toHaveAttribute('placeholder', 'Wien')
  })

  it('never greys out „Hinzufügen“: a press with nothing typed says what is missing, a value adds the Angabe', async () => {
    const onChange = form()
    const add = screen.getByTestId('filter-fact-add')
    expect(add).toBeEnabled()
    await userEvent.click(add)
    expect(screen.getByText('Bitte einen Wert eingeben.')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()

    await userEvent.type(screen.getByTestId('filter-fact-value'), '4')
    expect(screen.queryByText('Bitte einen Wert eingeben.')).not.toBeInTheDocument()
    await userEvent.click(add)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ filters: { facts: [{ key: 'building_class', equals: '4' }] } }))
  })
})
