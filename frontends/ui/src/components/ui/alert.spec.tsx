/**
 * The destructive alert's words are ink, its glyph the signal red: red words on
 * the danger tint measured 4.08:1, under WCAG AA's 4.5:1 for body text
 * (`grid-design-language.md`, „Measured contrasts that decide a token“). A
 * class assertion, because jsdom computes no colours; the axe run on the
 * previews measures the ratio itself.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Alert, AlertDescription, AlertTitle } from './alert'

describe('Alert variant="destructive"', () => {
  it('draws its words in ink and only the glyph in the error red', () => {
    render(
      <Alert variant="destructive" data-testid="alert">
        <svg aria-hidden />
        <AlertTitle>Konnte nicht geladen werden</AlertTitle>
        <AlertDescription>Bitte erneut versuchen.</AlertDescription>
      </Alert>
    )
    const classes = screen.getByTestId('alert').className.split(/\s+/)
    expect(classes).toContain('text-foreground')
    expect(classes).toContain('[&>svg]:text-error')
    expect(classes).toContain('*:data-[slot=alert-description]:text-foreground')
    // Red words are the 4.08:1 the kit used to ship.
    expect(classes).not.toContain('text-error')
    expect(classes).not.toContain('*:data-[slot=alert-description]:text-error')
  })
})
