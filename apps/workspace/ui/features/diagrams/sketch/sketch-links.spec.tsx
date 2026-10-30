import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedSketchLink } from '@/lib/diagrams/sketch-links'

const push = vi.hoisted(() => vi.fn())
const capture = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: capture }))
vi.mock('./sketch-link-picker', () => ({
  SketchLinkPicker: ({ onPick }: { onPick: (picked: unknown) => void }) => (
    <button
      type="button"
      data-testid="pick"
      onClick={() =>
        onPick({
          link: { documentId: 'doc_plan', page: 3 },
          reading: { state: 'available', title: 'Polierplan', place: { shelf: 'project', projectId: 'proj_1', documentId: 'doc_plan' }, page: 3 },
        })
      }
    />
  ),
}))

import { I18nProvider } from '@/i18n'
import { SketchLinks } from './sketch-links'
import type { SketchViewApi } from './sketch-pins'

type Element = { id: string; x: number; y: number; width: number; height: number; customData?: unknown }

function fakeApi(elements: Element[], selected: string[] = []) {
  const listeners: Array<() => void> = []
  const state = { scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: Object.fromEntries(selected.map((id) => [id, true])) }
  const api: SketchViewApi = {
    getSceneElements: () => elements,
    getAppState: () => state,
    onChange: (callback) => {
      listeners.push(callback)
      return () => undefined
    },
    onScrollChange: () => () => undefined,
  }
  return { api, changed: () => listeners.forEach((listener) => listener()) }
}

const GLOBAL_ID = '2O2Fr$t4X7Zf8NOew3FLOH'
const place = { shelf: 'project' as const, projectId: 'proj_1', documentId: 'doc_ifc' }
const LINKS: ResolvedSketchLink[] = [
  { elementId: 'room', kind: 'ifcElement', ref: { documentId: 'doc_ifc', ifcGlobalId: GLOBAL_ID }, state: 'available', title: 'Wohnen (IfcSpace)', place, modelFile: 'Haus.ifc' },
  { elementId: 'cloud', kind: 'annotation', ref: { documentId: 'doc_gone', annotationId: 'ann_1' }, state: 'unavailable' },
]

const view = (canvas: ReturnType<typeof fakeApi>, onLink = vi.fn(), canLink = true) =>
  render(
    <I18nProvider initialLocale="de" fixedLocale>
      <SketchLinks api={canvas.api} links={LINKS} projectId="proj_1" canLink={canLink} onLink={onLink} />
    </I18nProvider>
  )

beforeEach(() => vi.clearAllMocks())

describe('SketchLinks', () => {
  it('marks each linked element at its corner and opens an available target in the app', () => {
    const canvas = fakeApi([
      { id: 'room', x: 0, y: 0, width: 100, height: 60, customData: LINKS[0].ref },
      { id: 'plain', x: 0, y: 100, width: 100, height: 60 },
    ])
    view(canvas)
    const marks = screen.getAllByTestId('sketch-link-mark')
    expect(marks).toHaveLength(1)
    expect(marks[0].parentElement).toHaveStyle({ left: '100px', top: '0px' })
    fireEvent.click(marks[0])
    expect(push).toHaveBeenCalledWith(expect.stringContaining('element=2O2Fr%24t4X7Zf8NOew3FLOH'))
    expect(capture).toHaveBeenCalledWith('sketch_link_opened', { kind: 'ifcElement', state: 'available' })
  })

  it('says quietly that a target is gone, and opens nothing', () => {
    const canvas = fakeApi([{ id: 'cloud', x: 0, y: 0, width: 100, height: 60, customData: LINKS[1].ref }])
    view(canvas)
    fireEvent.click(screen.getByTestId('sketch-link-mark'))
    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Nicht mehr vorhanden')
    expect(capture).toHaveBeenCalledWith('sketch_link_opened', { kind: 'annotation', state: 'unavailable' })
  })

  it('offers „Verknüpfen“ on one selected element and writes the pick into it', async () => {
    const elements: Element[] = [{ id: 'note', x: 0, y: 0, width: 80, height: 40 }]
    const canvas = fakeApi(elements, ['note'])
    const onLink = vi.fn((id: string, link: unknown) => {
      elements[0].customData = link
    })
    view(canvas, onLink)
    fireEvent.click(screen.getByTestId('sketch-link'))
    fireEvent.click(await screen.findByTestId('pick'))
    expect(onLink).toHaveBeenCalledWith('note', { documentId: 'doc_plan', page: 3 })
    act(() => canvas.changed())
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
    expect(screen.getByTestId('sketch-link-mark')).toHaveAttribute('aria-label', 'Öffnen: Polierplan, S. 3')
  })

  it('offers no „Verknüpfen“ to a reader who may not write', () => {
    view(fakeApi([{ id: 'note', x: 0, y: 0, width: 80, height: 40 }], ['note']), vi.fn(), false)
    expect(screen.queryByTestId('sketch-link')).toBeNull()
  })
})
