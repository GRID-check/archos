import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

import { render, screen } from '@/test-utils'
import { SuggestInput, type SuggestOption } from './suggest-input'

const OPTIONS: SuggestOption[] = [
  { value: 'Atelier Lindner ZT GmbH', label: 'Atelier Lindner ZT GmbH', count: 14 },
  { value: 'norm:önorm b 1600', label: 'ÖNORM B 1600', count: 3, hint: 'Norm' },
]

function Field({ onPick = vi.fn(), onCommit = vi.fn(), options = OPTIONS }: { onPick?: (o: SuggestOption, i: number) => void; onCommit?: () => void; options?: SuggestOption[] }) {
  const [value, setValue] = useState('')
  return (
    <SuggestInput
      aria-label="Name"
      value={value}
      onValueChange={setValue}
      options={options}
      onPick={onPick}
      onCommit={onCommit}
      listLabel="Vorschläge"
      data-testid="field"
    />
  )
}

describe('SuggestInput', () => {
  it('is a combobox whose options carry their counts, with nothing active until an arrow is pressed', async () => {
    render(<Field />)
    const field = screen.getByRole('combobox', { name: 'Name' })
    await userEvent.click(field)
    expect(field).toHaveAttribute('aria-expanded', 'true')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveTextContent('14')
    expect(options[1]).toHaveTextContent('Norm')
    expect(field).not.toHaveAttribute('aria-activedescendant')
  })

  it('takes the active option on Enter, and what was typed when none is active', async () => {
    const onPick = vi.fn()
    const onCommit = vi.fn()
    render(<Field onPick={onPick} onCommit={onCommit} />)
    const field = screen.getByRole('combobox')
    await userEvent.type(field, 'At{Enter}')
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()

    await userEvent.type(field, '{ArrowDown}{ArrowDown}')
    expect(field).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1].id)
    await userEvent.keyboard('{ArrowUp}{Enter}')
    expect(onPick).toHaveBeenCalledWith(OPTIONS[0], 0)
  })

  it('closes the list on Escape and keeps the field focused; a press on an option takes it', async () => {
    const onPick = vi.fn()
    render(<Field onPick={onPick} />)
    const field = screen.getByRole('combobox')
    await userEvent.click(field)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(field).toHaveFocus()

    await userEvent.type(field, 'Ö')
    await userEvent.click(screen.getByRole('option', { name: /ÖNORM/ }))
    expect(onPick).toHaveBeenCalledWith(OPTIONS[1], 1)
    expect(field).toHaveFocus()
  })
})
