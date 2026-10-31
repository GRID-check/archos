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

describe('Button compact sizes', () => {
  // A card header or a banner over a list wanted a 28px action, and got it by
  // overriding `sm` by hand (`h-6`, `h-7`, `[&_svg]:size-3`): three heights in
  // one panel, and glyphs that matched no well. The sizes carry it now.
  it('draws xs at 28px with the 28px well’s glyph, and grows to a finger', () => {
    render(<Button size="xs">Übernehmen</Button>)
    const classes = screen.getByRole('button', { name: 'Übernehmen' }).className.split(/\s+/)
    expect(classes).toEqual(expect.arrayContaining(['h-7', 'text-xs', 'pointer-coarse:h-11', "[&_svg:not([class*='size-'])]:size-3.5"]))
  })

  it('gives the icon steps a square well that a finger can hit', () => {
    render(
      <>
        <Button size="icon-xs" aria-label="Erledigen" />
        <Button size="icon-sm" aria-label="Mehr" />
      </>
    )
    expect(screen.getByRole('button', { name: 'Erledigen' }).className.split(/\s+/)).toEqual(
      expect.arrayContaining(['size-7', 'pointer-coarse:size-11'])
    )
    expect(screen.getByRole('button', { name: 'Mehr' }).className.split(/\s+/)).toEqual(
      expect.arrayContaining(['size-8', 'pointer-coarse:size-11'])
    )
  })
})

/*
 * A loading button never moves its label or changes its width. With a leading
 * icon the spinner takes the icon's slot; without one there is no slot, so the
 * spinner centres over a transparent label that still holds the width and the
 * accessible name.
 */
describe('Button loading layout', () => {
  it('keeps the label in one span that decides, in CSS, where the spinner goes', () => {
    render(<Button loading>Speichern</Button>)
    const button = screen.getByRole('button', { name: 'Speichern' })
    const label = button.querySelector('[data-slot="button-label"]')
    const spinner = button.querySelector('[data-slot="spinner"]')

    expect(label).toHaveTextContent('Speichern')
    expect(label?.className).toContain('[&>svg:first-of-type]:hidden')
    expect(label?.className).toContain('[&:not(:has(>svg))]:opacity-0')
    // Placed after the label in the DOM so the label can be its `peer`, drawn first.
    expect(label?.nextElementSibling).toBe(spinner)
    expect(spinner?.className).toContain('order-first')
    expect(spinner?.className).toContain('peer-[:not(:has(>svg))]/label:absolute')
    expect(button.className).toContain('relative')
  })

  it('renders its children untouched when it is not loading', () => {
    render(<Button>Speichern</Button>)
    const button = screen.getByRole('button', { name: 'Speichern' })
    expect(button.querySelector('[data-slot="button-label"]')).toBeNull()
    expect(button.className).toContain('select-none')
  })
})
