/**
 * MonthInput: two selects for one `YYYY-MM`, named in the page's language,
 * reporting a month only once both halves are chosen.
 */
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { MonthInput } from './month-input'

const labels = { monthLabel: 'Monat', yearLabel: 'Jahr', clearLabel: 'Leeren' }

describe('MonthInput', () => {
  test('names the months in the given locale and shows a stored month', () => {
    render(<MonthInput value="2026-03" onChange={vi.fn()} locale="de" {...labels} />)
    expect(screen.getByRole('combobox', { name: 'Monat' })).toHaveTextContent('März')
    expect(screen.getByRole('combobox', { name: 'Jahr' })).toHaveTextContent('2026')
  })

  test('reports a month once both halves are chosen, and nothing before', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MonthInput value="" onChange={onChange} locale="de" {...labels} fromYear={2020} toYear={2026} />)
    await user.click(screen.getByRole('combobox', { name: 'Monat' }))
    await user.click(await screen.findByRole('option', { name: 'Juni' }))
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole('combobox', { name: 'Jahr' }))
    await user.click(await screen.findByRole('option', { name: '2024' }))
    expect(onChange).toHaveBeenCalledWith('2024-06')
  })

  test('keeps a stored year outside the range, and clears to nothing', async () => {
    const onChange = vi.fn()
    render(<MonthInput value="1985-11" onChange={onChange} locale="de" {...labels} fromYear={2000} />)
    expect(screen.getByRole('combobox', { name: 'Jahr' })).toHaveTextContent('1985')
    await userEvent.click(screen.getByRole('button', { name: 'Leeren' }))
    expect(onChange).toHaveBeenCalledWith('')
  })
})
