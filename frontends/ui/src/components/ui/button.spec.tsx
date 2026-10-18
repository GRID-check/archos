import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './button'

describe('Button loading', () => {
  it('swallows a second press but keeps the focus it had', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const { rerender } = render(<Button onClick={onClick}>Speichern</Button>)
    const button = screen.getByRole('button', { name: 'Speichern' })
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)

    // Disabling a focused button blurs it in Chrome: the keyboard reader lands
    // on <body>. Loading must not do that.
    rerender(
      <Button onClick={onClick} loading>
        Speichern
      </Button>
    )
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveFocus()
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does not submit its form while loading', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Senden
        </Button>
      </form>
    )
    await user.click(screen.getByRole('button', { name: 'Senden' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("announces itself as unavailable even when the caller passes aria-disabled={false}", () => {
    render(
      <Button loading aria-disabled={false}>
        Speichern
      </Button>
    )
    expect(screen.getByRole('button', { name: 'Speichern' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('is ignored entirely under asChild: no aria state, and the click goes through', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button asChild loading onClick={onClick}>
        <a href="#weiter">Weiter</a>
      </Button>
    )
    const link = screen.getByRole('link', { name: 'Weiter' })
    expect(link).not.toHaveAttribute('aria-disabled')
    expect(link).not.toHaveAttribute('aria-busy')
    await user.click(link)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('Button inline', () => {
  // `link` is ink like the sentence around it and underlines only on hover, so
  // „In der Prüfansicht öffnen" inside the approve confirm read as more text.
  it('is underlined at rest, and takes the sentence’s size and line whatever size it is given', () => {
    render(
      <p>
        4 offene Anmerkungen – trotzdem freigeben?{' '}
        <Button variant="inline" size="sm">
          In der Prüfansicht öffnen
        </Button>
      </p>
    )
    const button = screen.getByRole('button', { name: 'In der Prüfansicht öffnen' })
    const classes = button.className.split(/\s+/)
    expect(classes).toContain('underline')
    expect(classes).not.toContain('hover:underline')
    expect(classes).toEqual(expect.arrayContaining(['h-auto', 'p-0', 'text-[length:inherit]']))
    for (const sized of ['h-8', 'px-3.5', 'text-xs', 'pointer-coarse:h-11']) expect(classes).not.toContain(sized)
  })
})
