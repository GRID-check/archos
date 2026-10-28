/**
 * React bubbles a drag along the COMPONENT tree, so a dialog portalled out of
 * the zone's element still reached the zone: a file let go over a dialog opened
 * from a project page was sent to Dateien behind it, and one let go over a
 * dialog opened from the chat was attached to the conversation.
 */
import { createPortal } from 'react-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { outsideTheZone, useFileDragDrop } from './use-file-drag-drop'

vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    fileUpload: {
      acceptedTypes: '.pdf',
      acceptedMimeTypes: ['application/pdf'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))

function Zone({ onDrop }: { onDrop: (files: File[]) => void }) {
  const { isDragging, dragHandlers } = useFileDragDrop({ onDrop })
  return (
    <div {...dragHandlers} data-testid="zone" data-dragging={isDragging || undefined}>
      <p>Inside</p>
      {createPortal(<p>In a dialog</p>, document.body)}
    </div>
  )
}

const transfer = (files: File[]) => ({ types: ['Files'], files, items: [] })
const plan = new File(['%PDF'], 'Grundriss.pdf', { type: 'application/pdf' })

describe('useFileDragDrop — a portal is not the zone', () => {
  test('a drag over a portal the zone rendered is left to the window guard', async () => {
    const onDrop = vi.fn()
    render(<Zone onDrop={onDrop} />)

    fireEvent.dragEnter(screen.getByText('In a dialog'), { dataTransfer: transfer([plan]) })
    expect(screen.getByTestId('zone')).not.toHaveAttribute('data-dragging')
    // `fireEvent` answers false when a handler cancelled the event: the zone did not claim it.
    const notCancelled = fireEvent.drop(screen.getByText('In a dialog'), { dataTransfer: transfer([plan]) })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(notCancelled).toBe(true)
    expect(onDrop).not.toHaveBeenCalled()
  })

  test('a drop inside the zone is still the zone’s', async () => {
    const onDrop = vi.fn()
    render(<Zone onDrop={onDrop} />)

    fireEvent.dragEnter(screen.getByText('Inside'), { dataTransfer: transfer([plan]) })
    expect(screen.getByTestId('zone')).toHaveAttribute('data-dragging')
    fireEvent.drop(screen.getByText('Inside'), { dataTransfer: transfer([plan]) })

    await waitFor(() => expect(onDrop).toHaveBeenCalledWith([plan], { truncated: false, unreadable: 0 }))
  })

  test('an event without DOM nodes is taken as the zone’s own', () => {
    expect(outsideTheZone({ currentTarget: null, target: null } as never)).toBe(false)
  })
})
