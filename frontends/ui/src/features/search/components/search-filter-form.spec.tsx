import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

import { render, screen } from '@/test-utils'
import { I18nProvider } from '@/i18n'
import { EMPTY_SEARCH_STATE } from '../lib/search-url'
import { SearchFilterForm } from './search-filter-form'

function form(onChange = vi.fn()) {
  render(
    <I18nProvider initialLocale="de" fixedLocale>
      <SearchFilterForm state={EMPTY_SEARCH_STATE} onChange={onChange} defaultOpen />
    </I18nProvider>
  )
  return onChange
}

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
