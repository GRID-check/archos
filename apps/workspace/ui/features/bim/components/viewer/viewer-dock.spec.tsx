import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Home } from 'lucide-react'
import { ViewerDock } from './viewer-dock'
import { ViewerIconButton } from './viewer-icon-button'

describe('ViewerDock', () => {
  it('keeps the empty space around the pills out of the pointer’s way', () => {
    // The dock spans the full width so it can centre itself. If that wrapper
    // swallowed events, the bottom sixth of the model would be undraggable —
    // a dead strip across the building with no visible cause.
    const { container } = render(
      <ViewerDock>
        <ViewerIconButton label="Ebenen" icon={Home} />
      </ViewerDock>
    )
    const wrapper = container.firstElementChild
    expect(wrapper?.className).toContain('pointer-events-none')
    expect(screen.getByRole('button', { name: 'Ebenen' }).closest('.pointer-events-auto')).not.toBeNull()
  })

  it('sets the lead control apart in its own pill', () => {
    const { container } = render(
      <ViewerDock lead={<ViewerIconButton label="Ganzes Modell" icon={Home} />}>
        <ViewerIconButton label="Ebenen" icon={Home} />
      </ViewerDock>
    )
    // Two surfaces, not one row of buttons: "get me back" and "change what I
    // see" are different jobs and the gap is what says so.
    expect(container.querySelectorAll('[data-slot="viewer-surface"]')).toHaveLength(2)
  })

  it('keeps the way out inside the tool pill, behind a divider', () => {
    // NOT a third pill. Three floating bars two gaps apart read as three
    // competing objects rather than one control bar — the bottom of the
    // viewport ended up busier than the building.
    const { container } = render(
      <ViewerDock
        lead={<ViewerIconButton label="Ganzes Modell" icon={Home} />}
        trail={<ViewerIconButton label="Mehr" icon={Home} />}
      >
        <ViewerIconButton label="Ebenen" icon={Home} />
      </ViewerDock>
    )
    expect(container.querySelectorAll('[data-slot="viewer-surface"]')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Mehr' })).toBeInTheDocument()
  })

  it('renders the section slider above the bar rather than inside it', () => {
    render(
      <ViewerDock above={<div data-testid="cut-slider" />}>
        <ViewerIconButton label="Ebenen" icon={Home} />
      </ViewerDock>
    )
    expect(screen.getByTestId('cut-slider')).toBeInTheDocument()
  })

  describe('on a phone', () => {
    it('lays the tools out as one full-width bar that does not scroll', () => {
      // The desktop row was ~480 px in a 369 px viewport and scrolled sideways
      // behind a hidden scrollbar, which put the trailing tools off-screen with
      // nothing to say they existed. The bar shares its width instead.
      const { container } = render(
        <ViewerDock layout="bar">
          <ViewerIconButton label="Schnitt" icon={Home} />
          <ViewerIconButton label="Messen" icon={Home} />
        </ViewerDock>
      )
      const bar = container.querySelector('[data-slot="viewer-dock-bar"]')
      expect(bar).not.toBeNull()
      expect(bar?.className).toContain('w-full')
      expect(container.innerHTML).not.toContain('overflow-x-auto')
      expect(bar?.closest('.pointer-events-none')).not.toBeNull()
      expect(bar?.className).toContain('pointer-events-auto')
    })

    it('ignores lead and trail: what is not a tool belongs in a sheet, not in a second pill', () => {
      const { container } = render(
        <ViewerDock
          layout="bar"
          lead={<ViewerIconButton label="Zurück" icon={Home} />}
          trail={<ViewerIconButton label="Mehr" icon={Home} />}
        >
          <ViewerIconButton label="Schnitt" icon={Home} />
        </ViewerDock>
      )
      expect(screen.queryByRole('button', { name: 'Zurück' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Mehr' })).not.toBeInTheDocument()
      // One bar, and no second pill beside it.
      expect(container.querySelectorAll('[data-slot="viewer-dock-bar"]')).toHaveLength(1)
      expect(container.querySelectorAll('[data-slot="viewer-surface"]')).toHaveLength(0)
    })

    it('seats the sheet in the SAME column as the bar and the rows above it', () => {
      // One column that grows upward cannot overlap by arithmetic. The legend,
      // the cut slider and the sheet used to be positioned against each other
      // by hand, and `bottom-52` is right until the next row is added.
      render(
        <ViewerDock
          layout="bar"
          above={<div data-testid="above" />}
          sheet={<div data-testid="sheet" />}
        >
          <ViewerIconButton label="Schnitt" icon={Home} />
        </ViewerDock>
      )
      const column = screen.getByTestId('sheet').parentElement
      expect(column).toBe(screen.getByTestId('above').parentElement)
      expect(column).toBe(screen.getByRole('button', { name: 'Schnitt' }).closest('[data-slot="viewer-dock-bar"]')?.parentElement)
      const order = [...(column?.children ?? [])].map((child) => child.getAttribute('data-testid') ?? 'bar')
      expect(order).toEqual(['above', 'sheet', 'bar'])
    })

    it('turns the tools into a column on the left edge when the phone is on its side', () => {
      const { container } = render(
        <ViewerDock layout="side" sheet={<div data-testid="sheet" />}>
          <ViewerIconButton label="Schnitt" icon={Home} />
        </ViewerDock>
      )
      const column = container.querySelector('[data-slot="viewer-dock-column"]')
      expect(column?.className).toContain('flex-col')
      expect(column?.parentElement?.className).toContain('left-3')
      // And no bar along the bottom: 393 px of height cannot spare it.
      expect(container.querySelector('[data-slot="viewer-dock-bar"]')).toBeNull()
    })
  })
})
