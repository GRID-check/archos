import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

import { render, screen } from '@/test-utils'
import { DateInput, datePattern, formatDateValue, maskDateDraft, parseDateText } from './date-input'

const TOKENS_DE = { day: 'TT', month: 'MM', year: 'JJJJ' }

describe('DateInput', () => {
  it('writes and reads a day the way the locale does', () => {
    expect(formatDateValue('2026-10-27', 'de')).toBe('27.10.2026')
    expect(formatDateValue('2026-10-27', 'en-US')).toBe('10/27/2026')
    expect(parseDateText('27.10.2026', 'de')).toBe('2026-10-27')
    expect(parseDateText('1.2.26', 'de')).toBe('2026-02-01')
    expect(parseDateText('10/27/2026', 'en-US')).toBe('2026-10-27')
    expect(parseDateText('', 'de')).toBe('')
    expect(parseDateText('31.02.2026', 'de')).toBeNull()
    expect(parseDateText('2026', 'de')).toBeNull()
  })

  it('names the parts in the reader’s words and commits on Enter', async () => {
    const onChange = vi.fn()
    render(<DateInput value="" onChange={onChange} locale="de" tokens={TOKENS_DE} aria-label="Planstand von" />)
    const field = screen.getByRole('textbox', { name: 'Planstand von' })
    expect(field).toHaveAttribute('placeholder', 'TT.MM.JJJJ')
    await userEvent.type(field, '14.10.2026{Enter}')
    expect(onChange).toHaveBeenCalledWith('2026-10-14')
  })

  it('marks a day that does not exist, or lies past the bound, and sends nothing', async () => {
    const onChange = vi.fn()
    render(<DateInput value="" onChange={onChange} locale="de" tokens={TOKENS_DE} aria-label="Bis" min="2026-10-01" />)
    const field = screen.getByRole('textbox', { name: 'Bis' })
    await userEvent.type(field, '31.02.2026{Enter}')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    await userEvent.clear(field)
    await userEvent.type(field, '01.09.2026{Enter}')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('puts the separators in as the reader types, and reads digits typed without them', async () => {
    const onChange = vi.fn()
    render(<DateInput value="" onChange={onChange} locale="de" tokens={TOKENS_DE} aria-label="Von" />)
    const field = screen.getByRole('textbox', { name: 'Von' })
    await userEvent.type(field, '27102026')
    expect(field).toHaveValue('27.10.2026')
    await userEvent.type(field, '{Enter}')
    expect(onChange).toHaveBeenCalledWith('2026-10-27')
    expect(parseDateText('27102026', 'de')).toBe('2026-10-27')
    expect(parseDateText('10272026', 'en-US')).toBe('2026-10-27')
    expect(parseDateText('271026', 'de')).toBe('2026-10-27')
  })

  it('never doubles a separator the reader types too, and leaves a paste or a short part as typed', async () => {
    const de = datePattern('de')
    expect(maskDateDraft('27.', '27..', de)).toBe('27.')
    expect(maskDateDraft('1', '1.', de)).toBe('1.')
    expect(maskDateDraft('', '1.2.26', de)).toBe('1.2.26')
    expect(maskDateDraft('27.10.202', '27.10.2026', de)).toBe('27.10.2026')
    expect(maskDateDraft('10/2', '10/27', datePattern('en-US'))).toBe('10/27/')
    const onChange = vi.fn()
    render(<DateInput value="" onChange={onChange} locale="de" tokens={TOKENS_DE} aria-label="Bis" />)
    const field = screen.getByRole('textbox', { name: 'Bis' })
    await userEvent.type(field, '14.10.2026')
    expect(field).toHaveValue('14.10.2026')
  })
})
