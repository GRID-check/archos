/**
 * A Skizze's review is its editor (migration 0192): a pin in the Files preview,
 * or a link with `?review=1&mark=`, opens the sketch editor at that mark, never
 * the PDF review, and closing it hands the address back.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./sketch-dialog', () => ({
  SketchDialog: ({
    open,
    onOpenChange,
    revision,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    revision?: { review?: unknown }
  }) =>
    open ? (
      <div data-testid="sketch-dialog" data-review={revision?.review ? 'yes' : 'no'}>
        <button type="button" onClick={() => onOpenChange(false)}>
          close
        </button>
      </div>
    ) : null,
}))

import { SketchReviseAction } from './sketch-revise-action'

const SKETCH = { documentId: 'doc-svg', versionId: 'v1', title: 'Stiege', scene: { type: 'excalidraw', elements: [] } }

afterEach(() => vi.unstubAllGlobals())

describe('a review request on a Skizze', () => {
  it('opens the editor with the review, at the requested mark, and hands the address back on close', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => SKETCH }))
    )
    const select = vi.fn()
    const onOpenChange = vi.fn()
    const review = { select } as never
    render(
      <SketchReviseAction
        documentId="doc-svg"
        contentType="image/svg+xml"
        authoredBy="agent"
        onChanged={() => {}}
        review={review}
        reviewRequest={{ open: true, annotationId: 'mark-4', onOpenChange }}
      />
    )
    const dialog = await screen.findByTestId('sketch-dialog')
    expect(dialog.dataset.review).toBe('yes')
    await waitFor(() => expect(select).toHaveBeenCalledWith('mark-4'))
    act(() => screen.getByText('close').click())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
