import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SketchRequestError } from '@/adapters/api/diagrams-client'
import type { SketchUnderlayView } from '@/lib/diagrams/sketch-underlay-wire'
import { I18nProvider } from '@/i18n'
import { UnderlayBanner, UnderlayMoveDialog } from './sketch-underlay'

const REF = { documentId: '22222222-2222-4222-8222-222222222222', versionId: '33333333-3333-4333-8333-333333333333', page: 2, dpi: 150 as const }
const drifted: Extract<SketchUnderlayView, { state: 'available' }> = {
  state: 'available',
  elementId: 'page',
  ref: REF,
  title: 'Lageplan.pdf',
  versionNumber: 3,
  newer: { versionId: 'v4', versionNumber: 4 },
}
const wrap = (node: React.ReactNode) => render(<I18nProvider initialLocale="de" fixedLocale>{node}</I18nProvider>)

describe('UnderlayBanner', () => {
  it('says what the strokes lie on, that nothing is measured, and that a newer Fassung exists', () => {
    wrap(<UnderlayBanner underlay={drifted} shown documentId="sketch" baseVersionId="s1" canMove onMoved={() => undefined} />)
    expect(screen.getByTestId('sketch-underlay').textContent).toContain('Liegt auf Lageplan.pdf, Fassung 3, S. 2')
    expect(screen.getByTestId('sketch-underlay-drift').textContent).toBe('liegt auf Fassung 3, aktuell 4')
    expect(screen.getByTestId('sketch-underlay').textContent).toContain('nicht maßstäblich')
    expect(screen.getByTestId('sketch-underlay-move').textContent).toBe('Auf neue Fassung übertragen')
  })

  it('says the page is not available and names nothing of it', () => {
    wrap(<UnderlayBanner underlay={{ state: 'unavailable', elementId: 'page', ref: REF }} shown={null} documentId="sketch" baseVersionId="s1" canMove onMoved={() => undefined} />)
    expect(screen.getByTestId('sketch-underlay-unavailable').textContent).not.toContain('Lageplan')
  })
})

describe('UnderlayMoveDialog', () => {
  it('shows old and new, says how the page was found, and moves only on the person’s word', async () => {
    const move = vi.fn(async () => ({ versionNumber: 6 }))
    const onMoved = vi.fn()
    const plan = vi.fn(async () => ({
      from: { versionId: REF.versionId, versionNumber: 3, page: 2, pageLabel: 'A-101' },
      to: { versionId: 'v4', versionNumber: 4, page: 3, pageLabel: 'A-101' },
      matchedBy: 'label' as const,
      labelGone: false,
    }))
    wrap(
      <UnderlayMoveDialog open onOpenChange={() => undefined} documentId="sketch" baseVersionId="s5" underlay={drifted} onMoved={onMoved} planOf={plan} move={move} rasterUrl={(ref) => `/raster/${ref.versionId}/${ref.page}`} />
    )
    await waitFor(() => expect(screen.getByTestId('sketch-underlay-plan').textContent).toContain('„A-101“ der Fassung 4'))
    const images = () => [...screen.getByTestId('sketch-underlay-compare').querySelectorAll('img')].map((img) => img.getAttribute('src'))
    expect(images()).toEqual([`/raster/${REF.versionId}/2`, '/raster/v4/3'])
    expect(move).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByTestId('sketch-underlay-move-confirm')))
    expect(move).toHaveBeenCalledWith('sketch', 's5', 'v4', undefined)
    expect(onMoved).toHaveBeenCalledWith(6)
  })

  const fromA101 = { versionId: REF.versionId, versionNumber: 3, page: 2, pageLabel: 'A-101' }

  it('says when the label is gone and the page number was taken instead', async () => {
    const plan = vi.fn(async () => ({ from: fromA101, to: { versionId: 'v4', versionNumber: 4, page: 2, pageLabel: null }, matchedBy: 'index' as const, labelGone: true }))
    wrap(<UnderlayMoveDialog open onOpenChange={() => undefined} documentId="sketch" baseVersionId="s5" underlay={drifted} onMoved={() => undefined} planOf={plan} move={vi.fn()} rasterUrl={() => '/r'} />)
    await waitFor(() => expect(screen.getByTestId('sketch-underlay-plan').textContent).toContain('„A-101“ gibt es dort nicht mehr'))
  })

  it('lets the person choose when two pages carry the label, and moves to the chosen one', async () => {
    const plan = vi.fn(async (_id: string, page?: number) => {
      if (!page) throw new SketchRequestError(422, null, 'label_ambiguous', [3, 7])
      return { from: fromA101, to: { versionId: 'v4', versionNumber: 4, page, pageLabel: 'A-101' }, matchedBy: 'chosen' as const, labelGone: false }
    })
    const move = vi.fn(async () => ({ versionNumber: 6 }))
    wrap(<UnderlayMoveDialog open onOpenChange={() => undefined} documentId="sketch" baseVersionId="s5" underlay={drifted} onMoved={() => undefined} planOf={plan} move={move} rasterUrl={() => '/r'} />)
    await waitFor(() => expect(screen.getByTestId('sketch-underlay-choices')).toBeTruthy())
    expect((screen.getByTestId('sketch-underlay-move-confirm') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => fireEvent.click(screen.getByText('S. 7')))
    await waitFor(() => expect(screen.getByTestId('sketch-underlay-plan').textContent).toContain('Seite 7 der Fassung 4, von Ihnen gewählt'))
    await act(async () => fireEvent.click(screen.getByTestId('sketch-underlay-move-confirm')))
    expect(move).toHaveBeenCalledWith('sketch', 's5', 'v4', 7)
  })
})
