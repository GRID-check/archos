/**
 * A filed sketch reopened from Files (ADR-0148): offered only where the server
 * says the document carries a scene, and saved as a new Fassung, with a newer
 * one reported rather than overwritten.
 */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./sketch-dialog', () => ({
  SketchDialog: ({ open, revision }: { open: boolean; revision?: { baseVersionId: string | null } }) =>
    open ? <div data-testid="sketch-dialog">{revision?.baseVersionId}</div> : null,
}))

import { SketchReviseAction } from './sketch-revise-action'
import { useSketchRevision } from './use-sketch-revision'

const SKETCH = {
  documentId: 'doc-svg',
  versionId: 'v1',
  title: 'Raumprogramm',
  scene: { type: 'excalidraw', elements: [{ id: 'room', type: 'rectangle' }] },
}

function respond(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body }
}

afterEach(() => vi.unstubAllGlobals())

describe('SketchReviseAction', () => {
  it('offers „Als Skizze bearbeiten" on a filed sketch and opens the editor on its Fassung', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, SKETCH)))
    render(<SketchReviseAction documentId="doc-svg" contentType="image/svg+xml" authoredBy="agent" onChanged={() => {}} />)
    const button = await screen.findByTestId('sketch-revise')
    act(() => button.click())
    expect(screen.getByTestId('sketch-dialog').textContent).toBe('v1')
  })

  it('offers nothing where the server says there is no scene', async () => {
    const fetch = vi.fn(async () => respond(415, { error: 'Not a sketch' }))
    vi.stubGlobal('fetch', fetch)
    render(<SketchReviseAction documentId="doc-mermaid" contentType="image/svg+xml" authoredBy="agent" onChanged={() => {}} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('sketch-revise')).toBeNull()
  })

  it('does not ask about a file that cannot be a filed sketch', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(<SketchReviseAction documentId="doc" contentType="application/pdf" authoredBy="agent" onChanged={() => {}} />)
    render(<SketchReviseAction documentId="doc" contentType="image/svg+xml" authoredBy="user" onChanged={() => {}} />)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('useSketchRevision', () => {
  const prepare = async () => ({ source: JSON.stringify(SKETCH.scene), svg: '<svg/>' })

  it('saves the scene against the Fassung it opened and reports the new number', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(200, { documentId: 'doc-svg', versionId: 'v2', versionNumber: 2, pdf: null })
    )
    vi.stubGlobal('fetch', fetch)
    const onSaved = vi.fn()
    const { result } = renderHook(() => useSketchRevision({ documentId: 'doc-svg', baseVersionId: 'v1' }, prepare, onSaved))
    await act(() => result.current.save())
    expect(result.current.state).toEqual({ kind: 'saved', versionNumber: 2 })
    expect(fetch.mock.calls[0][1]?.method).toBe('PUT')
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      scene: SKETCH.scene,
      svg: '<svg/>',
      baseVersionId: 'v1',
    })
    expect(onSaved).toHaveBeenCalled()
  })

  it('tells a person a newer Fassung exists on 409, and overwrites nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(409, { error: 'A newer version', details: { reason: 'stale_base_version', currentVersionId: 'v3' } }))
    )
    const { result } = renderHook(() => useSketchRevision({ documentId: 'doc-svg', baseVersionId: 'v1' }, prepare))
    await act(() => result.current.save())
    expect(result.current.state).toEqual({ kind: 'stale' })
  })
})
