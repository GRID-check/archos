/**
 * The title a mermaid source carries in its front matter, read in time linear
 * in the source: the model writes the source, so its whitespace is not ours to
 * bound, and the title is read on every render of a drawn view.
 */
import { createElement, type ComponentProps } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { elapsedMs, growthRatio, LINEAR_BOUND } from '@/test-utils/growth'
import { DiagramFilingProvider } from './diagram-filing-context'
import { titleFromSource, useDiagramFiling } from './use-diagram-filing'

describe('titleFromSource', () => {
  it('reads the title out of the front matter', () => {
    expect(titleFromSource('---\ntitle: Verfahren\n---\nflowchart LR\n  A --> B')).toBe('Verfahren')
    expect(titleFromSource('\n  ---  \r\nconfig: {}\r\n  title:   Ablauf  \r\n---\nflowchart LR')).toBe('Ablauf')
  })

  it('has none without a closed front matter, or without a title in it', () => {
    expect(titleFromSource('flowchart LR\n  A --> B')).toBeNull()
    expect(titleFromSource('---\ntitle: Offen\nflowchart LR')).toBeNull()
    expect(titleFromSource('---\nconfig: {}\n---\ntitle: danach')).toBeNull()
    expect(titleFromSource('---\ntitle:\n---')).toBeNull()
  })

  it('caps a long title', () => {
    expect(titleFromSource(`---\ntitle: ${'x'.repeat(500)}\n---`)).toHaveLength(200)
  })

  it.each([
    ['a long run of blank lines in unclosed front matter', (n: number) => `---\n${'\n'.repeat(n)}x`],
    ['a long run of spaces inside the title', (n: number) => `---\ntitle: a${' '.repeat(n)}b\n---`],
  ])('is linear in %s', (_, source) => {
    const time = (n: number) => {
      const text = source(n)
      return elapsedMs(() => titleFromSource(text))
    }
    // Quadratic, 8 times the run took ~64 times as long; linear, ~8 times.
    expect(growthRatio(time, { size: 2000, floorMs: 0.05 })).toBeLessThan(LINEAR_BOUND)
  })
})

describe('useDiagramFiling — the conversation rides with the filing (ADR-0087)', () => {
  it('sends the conversation the answer belongs to, so a confined thread is refused an open folder', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return { ok: true, status: 201, json: async () => ({ svg: { documentId: 'doc-svg' }, pdf: null }) }
      })
    )
    const target = { projectId: 'proj-1', answerId: 'msg-1', conversationId: 's_conv_1' }
    const { result } = renderHook(() => useDiagramFiling({ source: 'flowchart LR\n  A --> B', fileSvg: '<svg/>' }), {
      // `children` travels as createElement's third argument; the props type
      // requires it, so the props object is asserted to the component's own.
      wrapper: ({ children }) =>
        createElement(DiagramFilingProvider, { target } as ComponentProps<typeof DiagramFilingProvider>, children),
    })

    await act(() => result.current.file())

    expect(bodies[0]).toMatchObject({ conversationId: 's_conv_1' })
    vi.unstubAllGlobals()
  })
})

describe('useDiagramFiling — a sketch a person edited (ADR-0141)', () => {
  const filingFetch = (bodies: Record<string, unknown>[], pdf: unknown) =>
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return { ok: true, status: 201, json: async () => ({ svg: { documentId: 'doc-svg' }, pdf }) }
    })
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(
      DiagramFilingProvider,
      { target: { projectId: 'proj-1', answerId: 'msg-1' } } as ComponentProps<typeof DiagramFilingProvider>,
      children
    )

  it('files the scene the editor hands over, as an edited Excalidraw drawing, keyed by that scene', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', filingFetch(bodies, { documentId: 'doc-pdf' }))
    const prepareSketch = vi.fn(async () => ({ source: '{"type":"excalidraw"}', svg: '<svg/>' }))
    const { result } = renderHook(
      () => useDiagramFiling({ source: '---\ntitle: Ablauf\n---\nflowchart LR\n  A --> B', fileSvg: null, prepareSketch }),
      { wrapper }
    )

    expect(result.current.canFile).toBe(true)
    await act(() => result.current.file())

    expect(prepareSketch).toHaveBeenCalledOnce()
    expect(bodies[0]).toMatchObject({
      sourceKind: 'excalidraw',
      source: '{"type":"excalidraw"}',
      svg: '<svg/>',
      edited: true,
      answerId: 'msg-1',
      title: 'Ablauf',
    })
    expect(bodies[0].runId).toMatch(/^msg-1-[0-9a-f]{8}$/)
    expect(result.current.state).toEqual({ kind: 'filed', documentId: 'doc-svg' })
    vi.unstubAllGlobals()
  })

  it('does not mark a drawing filed as drawn as edited', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', filingFetch(bodies, null))
    const { result } = renderHook(() => useDiagramFiling({ source: 'flowchart LR\n  A --> B', fileSvg: '<svg/>' }), {
      wrapper,
    })
    await act(() => result.current.file())
    expect(bodies[0]).toMatchObject({ sourceKind: 'mermaid', answerId: 'msg-1' })
    expect(bodies[0]).not.toHaveProperty('edited')
    vi.unstubAllGlobals()
  })
})
