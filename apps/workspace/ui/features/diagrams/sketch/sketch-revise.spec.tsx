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
  it('offers „Als Skizze bearbeiten" on a probe the download log skips, and opens on a logged read of the latest Fassung', async () => {
    const answers = [{ hasScene: true, canWrite: true, versionId: 'v1' }, { ...SKETCH, versionId: 'v2' }]
    const fetch = vi.fn(async (_url: string) => respond(200, answers.shift()))
    vi.stubGlobal('fetch', fetch)
    render(<SketchReviseAction documentId="doc-svg" contentType="image/svg+xml" authoredBy="agent" onChanged={() => {}} />)
    const button = await screen.findByTestId('sketch-revise')
    act(() => button.click())
    expect(await screen.findByTestId('sketch-dialog')).toHaveTextContent('v2')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/documents/doc-svg/sketch?probe=1', '/api/documents/doc-svg/sketch'])
  })

  it('reads the preview again when a colleague’s save, a Freigabe or an upload makes another Fassung current (G1)', async () => {
    const fetch = vi.fn(async (_url: string) => respond(200, { hasScene: true, canWrite: true, versionId: 'v1' }))
    vi.stubGlobal('fetch', fetch)
    const listeners: Array<(event: unknown) => void> = []
    const room = { peerId: 'peer_mine0001', onRoomEvent: (listener: (event: unknown) => void) => (listeners.push(listener), () => {}) }
    const onChanged = vi.fn()
    const review = { room, select: () => {} } as never
    render(<SketchReviseAction documentId="doc-svg" contentType="image/svg+xml" authoredBy="agent" onChanged={onChanged} review={review} />)
    await screen.findByTestId('sketch-revise')
    const actor = (peerId: string | null) => ({ userId: 'user_max', name: 'Max', kind: 'person', peerId })
    act(() => listeners.forEach((listener) => listener({ kind: 'version.published', versionId: 'v2', actor: actor('peer_mine0001') })))
    expect(onChanged).not.toHaveBeenCalled()
    act(() => listeners.forEach((listener) => listener({ kind: 'version.published', versionId: 'v2', actor: actor(null) })))
    expect(onChanged).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
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
    expect(result.current.state).toEqual({ kind: 'saved', versionId: 'v2', versionNumber: 2, pdfStale: false, draft: false })
    expect(fetch.mock.calls[0][1]?.method).toBe('PUT')
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      // No picture: the server draws it from the scene (ADR-0149).
      scene: SKETCH.scene,
      baseVersionId: 'v1',
      baseContentHash: null,
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

  it('in a room: saves against the base it has then, and after a 409 merges the newer Fassung and tries once more', async () => {
    const answers = [
      respond(409, { error: 'A newer version', details: { reason: 'stale_base_version', currentVersionId: 'v3' } }),
      respond(200, { documentId: 'doc-svg', versionId: 'v4', versionNumber: 4, pdf: null }),
    ]
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => answers.shift()!)
    vi.stubGlobal('fetch', fetch)
    let base = 'v1'
    const resolveStale = vi.fn(async () => {
      base = 'v3'
      return true
    })
    const { result } = renderHook(() =>
      useSketchRevision({ documentId: 'doc-svg', baseVersionId: () => base }, prepare, undefined, resolveStale)
    )
    await act(() => result.current.save())
    expect(resolveStale).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).baseVersionId)).toEqual(['v1', 'v3'])
    expect(result.current.state).toEqual({ kind: 'saved', versionId: 'v4', versionNumber: 4, pdfStale: false, draft: false })
  })

  it('in a room: takes the base before the scene, so a merge while the picture is drawn makes the save stale, not lossy', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(200, { documentId: 'doc-svg', versionId: 'v3', versionNumber: 3, pdf: null, pdfStale: true })
    )
    vi.stubGlobal('fetch', fetch)
    let base = 'v1'
    // A newer Fassung is merged in while the canvas draws its SVG.
    const slowPrepare = async () => {
      base = 'v2'
      return prepare()
    }
    const onSaved = vi.fn()
    const { result } = renderHook(() =>
      useSketchRevision({ documentId: 'doc-svg', baseVersionId: () => base, peerId: () => 'peer_anna0001' }, slowPrepare, onSaved)
    )
    await act(() => result.current.save())
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).baseVersionId).toBe('v1')
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('x-room-peer-id')).toBe('peer_anna0001')
    expect(result.current.state).toMatchObject({ kind: 'saved', pdfStale: true })
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ elements: SKETCH.scene.elements }))
  })

  it('saves into the open Freigabe draft from the hash it sits on, and says it is the draft', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(200, { versionId: 'd1', versionNumber: 3, state: 'draft', contentHash: 'sha256:new' })
    )
    vi.stubGlobal('fetch', fetch)
    const onSaved = vi.fn()
    const target = { documentId: 'doc-svg', baseVersionId: 'd1', baseContentHash: () => 'sha256:old' }
    const { result } = renderHook(() => useSketchRevision(target, prepare, onSaved))
    await act(() => result.current.save())
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ baseVersionId: 'd1', baseContentHash: 'sha256:old' })
    expect(result.current.state).toMatchObject({ kind: 'saved', draft: true, versionNumber: 3 })
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ state: 'draft', contentHash: 'sha256:new' }))
  })

  it('says the sketch is in review on 409 review_open, saves nothing, and lets the person draw on (C4)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(409, { error: 'In review', details: { reason: 'review_open', versionId: 'd1', state: 'in_review' } }))
    )
    const resolveStale = vi.fn(async () => true)
    const { result } = renderHook(() => useSketchRevision({ documentId: 'doc-svg', baseVersionId: 'v1' }, prepare, undefined, resolveStale))
    await act(() => result.current.save())
    expect(result.current.state).toEqual({ kind: 'review_open' })
    expect(resolveStale).not.toHaveBeenCalled()
    act(() => result.current.dismiss())
    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  it('in a room: a second 409 asks the person to save again, the newer Fassung merged', async () => {
    const stale = () => respond(409, { error: 'A newer version', details: { reason: 'stale_base_version' } })
    vi.stubGlobal('fetch', vi.fn(async () => stale()))
    const { result } = renderHook(() =>
      useSketchRevision({ documentId: 'doc-svg', baseVersionId: 'v1' }, prepare, undefined, async () => true)
    )
    await act(() => result.current.save())
    expect(result.current.state).toEqual({ kind: 'stale', merged: true })
  })
})
