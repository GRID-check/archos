/**
 * The proposal shell's lifecycle accent, because "pending" is a lifecycle
 * state and not a compliance warning (§A3).
 */

import { describe, expect, it } from 'vitest'
import { render as rtlRender } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '@/i18n'
import { ProposalShell } from './ProposalShell'

const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>,
  )

describe('ProposalShell', () => {
  it('draws no accent edge in any state, and never the warning colour', () => {
    // Side stripes are discouraged (design-language.md, "Emphasis without
    // a stripe"), and lifecycle is its own axis (§A3): amber means "close to a
    // limit" everywhere else in the set.
    for (const tone of ['pending', 'accepted', 'dismissed'] as const) {
      const { container, unmount } = render(<ProposalShell tone={tone}>Text</ProposalShell>)
      const card = container.querySelector('[data-slot="card"]')
      expect(card?.className, tone).not.toMatch(/border-l|warning/)
      unmount()
    }
  })

  it('shows a pending question bare, and an outcome as a glyph beside its words', () => {
    const { container: pending } = render(<ProposalShell tone="pending">Merken?</ProposalShell>)
    expect(pending.querySelector('[data-outcome]')).toBeNull()

    const { container: accepted } = render(<ProposalShell tone="accepted">Ja</ProposalShell>)
    const check = accepted.querySelector('[data-outcome="accepted"]')
    expect(check).toHaveClass('lucide-circle-check', 'text-success')

    const { container: dismissed } = render(<ProposalShell tone="dismissed">Nein</ProposalShell>)
    expect(dismissed.querySelector('[data-outcome="dismissed"]')).toHaveClass(
      'lucide-circle-minus',
      'text-muted-foreground',
    )
  })
})
