import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Info, Ruler } from 'lucide-react'
import { InspectorGroup, InspectorRow, InspectorSection } from './inspector-group'

describe('InspectorSection, InspectorGroup, InspectorRow', () => {
  it('renders what it is given: a section is a named region holding its group and rows', () => {
    // The first cut of `InspectorGroup` destructured `children` and never passed
    // them on, so every group on the rail drew as an empty white bar.
    render(
      <InspectorSection label="Properties" icon={Info}>
        <InspectorGroup>
          <InspectorRow label="Origin" icon={Ruler}>
            P:/Projekte/Plan.pdf
          </InspectorRow>
        </InspectorGroup>
      </InspectorSection>
    )
    const region = screen.getByRole('region', { name: 'Properties' })
    expect(region).toHaveTextContent('Origin')
    expect(region).toHaveTextContent('P:/Projekte/Plan.pdf')
  })

  it('gives label and value one type, so they share a baseline whatever the value is', () => {
    // The rows this replaced let each value set its own size on an inline span,
    // which sat 2–4px below its label by a different amount per row.
    render(
      <InspectorGroup>
        <InspectorRow label="Size" icon={Ruler}>
          <span>4.8 MB</span>
        </InspectorRow>
      </InspectorGroup>
    )
    const row = screen.getByText('Size').closest('[data-slot=inspector-row]')!
    expect(row.className).toContain('text-xs/5')
    expect(screen.getByText('4.8 MB').className).toBe('')
  })
})
