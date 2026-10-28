import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Quote } from './quote'

describe('Quote', () => {
  it('sets someone else’s words as a blockquote, indented and italic, with no side stripe', () => {
    render(<Quote>Bitte prüfen.</Quote>)
    const quote = screen.getByText('Bitte prüfen.')
    expect(quote.tagName).toBe('BLOCKQUOTE')
    expect(quote).toHaveClass('ps-3', 'italic', 'text-muted-foreground')
    expect(quote.className).not.toMatch(/border-l/)
  })

  it('sets an excerpt on a tinted surface and a paraphrase upright on a dashed hairline', () => {
    render(
      <>
        <Quote variant="excerpt">Wortlaut</Quote>
        <Quote variant="paraphrase">Sinngemäß</Quote>
      </>,
    )
    expect(screen.getByText('Wortlaut')).toHaveClass('rounded-lg', 'bg-muted/60', 'italic')
    expect(screen.getByText('Sinngemäß')).toHaveClass('border', 'border-dashed', 'not-italic')
  })

  it('renders the element it is asked for and lets the caller set the type', () => {
    render(
      <Quote as="p" className="text-xs" data-testid="q">
        Frage
      </Quote>,
    )
    const quote = screen.getByTestId('q')
    expect(quote.tagName).toBe('P')
    expect(quote).toHaveClass('text-xs')
    expect(quote).toHaveAttribute('data-slot', 'quote')
  })
})
