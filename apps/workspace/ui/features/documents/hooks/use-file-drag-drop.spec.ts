import { renderHook, act } from '@testing-library/react'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { useFileDragDrop } from './use-file-drag-drop'

// Mock the validation module
vi.mock('../validation', () => ({
  checkDraggedFilesSupported: vi.fn(() => true),
}))

// Mock useAppConfig
vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    authRequired: true,
    fileUpload: {
      acceptedTypes: '.pdf,.docx,.txt,.md',
      acceptedMimeTypes: ['application/pdf', 'text/plain', 'text/markdown'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))

import { checkDraggedFilesSupported } from '../validation'

/**
 * A drag carrying files from the desktop.
 *
 * `types: ['Files']` is not decoration — it is the fact this hook discriminates
 * on, and the browser sets it for every drag that carries real files and for no
 * drag started inside the page. The fixture omitted it, which is how the hook
 * came to answer for in-app drags too: nothing here could tell the two apart, so
 * nothing here noticed that the hook could not either.
 */
function createMockDragEvent(files: File[] = [], items: DataTransferItem[] = []): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      types: ['Files'],
      files,
      items: items.length > 0 ? items : files.map(() => ({ kind: 'file', type: 'application/pdf' })),
    },
  } as unknown as React.DragEvent
}

/** A drag started inside the page — a document being moved into a folder. */
function createInternalDragEvent(type = 'application/x-document-id'): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      types: [type],
      files: [],
      items: [{ kind: 'string', type }],
    },
  } as unknown as React.DragEvent
}

describe('useFileDragDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(checkDraggedFilesSupported).mockReturnValue(true)
  })

  test('returns initial state with isDragging false', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    expect(result.current.isDragging).toBe(false)
    expect(result.current.isUnsupportedDrag).toBe(false)
    expect(result.current.dragHandlers).toBeDefined()
    expect(result.current.dragHandlers.onDragEnter).toBeInstanceOf(Function)
    expect(result.current.dragHandlers.onDragLeave).toBeInstanceOf(Function)
    expect(result.current.dragHandlers.onDragOver).toBeInstanceOf(Function)
    expect(result.current.dragHandlers.onDrop).toBeInstanceOf(Function)
  })

  test('sets isDragging to true on dragEnter with files', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const mockEvent = createMockDragEvent(
      [new File(['content'], 'test.pdf', { type: 'application/pdf' })],
      [{ kind: 'file', type: 'application/pdf' } as DataTransferItem]
    )

    act(() => {
      result.current.dragHandlers.onDragEnter(mockEvent)
    })

    expect(result.current.isDragging).toBe(true)
    expect(mockEvent.preventDefault).toHaveBeenCalled()
    expect(mockEvent.stopPropagation).toHaveBeenCalled()
  })

  test('asks whether a zip counts only when the surface unpacks them', () => {
    vi.mocked(checkDraggedFilesSupported).mockClear()
    const zip = createMockDragEvent(
      [new File(['z'], 'a.zip')],
      [{ kind: 'file', type: 'application/zip' } as DataTransferItem]
    )

    const chat = renderHook(() => useFileDragDrop({ onDrop: vi.fn() }))
    act(() => chat.result.current.dragHandlers.onDragEnter(zip))
    const shelf = renderHook(() => useFileDragDrop({ onDrop: vi.fn(), acceptZip: true }))
    act(() => shelf.result.current.dragHandlers.onDragEnter(zip))

    const options = vi.mocked(checkDraggedFilesSupported).mock.calls.map((call) => call[2])
    expect(options).toEqual([{ allowZip: false }, { allowZip: true }])
  })

  test('sets isUnsupportedDrag when files are unsupported', () => {
    vi.mocked(checkDraggedFilesSupported).mockReturnValue(false)

    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const mockEvent = createMockDragEvent(
      [new File(['content'], 'test.exe', { type: 'application/x-msdownload' })],
      [{ kind: 'file', type: 'application/x-msdownload' } as DataTransferItem]
    )

    act(() => {
      result.current.dragHandlers.onDragEnter(mockEvent)
    })

    expect(result.current.isDragging).toBe(true)
    expect(result.current.isUnsupportedDrag).toBe(true)
  })

  test('resets isDragging on dragLeave when counter reaches zero', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const enterEvent = createMockDragEvent(
      [new File(['content'], 'test.pdf', { type: 'application/pdf' })],
      [{ kind: 'file', type: 'application/pdf' } as DataTransferItem]
    )

    // Enter once
    act(() => {
      result.current.dragHandlers.onDragEnter(enterEvent)
    })
    expect(result.current.isDragging).toBe(true)

    // Leave once
    const leaveEvent = createMockDragEvent()
    act(() => {
      result.current.dragHandlers.onDragLeave(leaveEvent)
    })
    expect(result.current.isDragging).toBe(false)
  })

  test('keeps isDragging true with nested drag enter/leave', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const enterEvent = createMockDragEvent(
      [new File(['content'], 'test.pdf', { type: 'application/pdf' })],
      [{ kind: 'file', type: 'application/pdf' } as DataTransferItem]
    )
    const leaveEvent = createMockDragEvent()

    // Enter parent
    act(() => {
      result.current.dragHandlers.onDragEnter(enterEvent)
    })
    // Enter child
    act(() => {
      result.current.dragHandlers.onDragEnter(enterEvent)
    })
    expect(result.current.isDragging).toBe(true)

    // Leave child
    act(() => {
      result.current.dragHandlers.onDragLeave(leaveEvent)
    })
    // Should still be dragging (counter = 1)
    expect(result.current.isDragging).toBe(true)

    // Leave parent
    act(() => {
      result.current.dragHandlers.onDragLeave(leaveEvent)
    })
    // Now should be false (counter = 0)
    expect(result.current.isDragging).toBe(false)
  })

  test('calls onDrop with files and resets state', async () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const file = new File(['content'], 'test.pdf', { type: 'application/pdf' })
    const enterEvent = createMockDragEvent(
      [file],
      [{ kind: 'file', type: 'application/pdf' } as DataTransferItem]
    )
    const dropEvent = createMockDragEvent([file])

    // Enter to set dragging state
    act(() => {
      result.current.dragHandlers.onDragEnter(enterEvent)
    })
    expect(result.current.isDragging).toBe(true)

    // Drop
    // The drop path is asynchronous now: a DROPPED FOLDER is invisible to
    // `dataTransfer.files` and has to be walked through the entries API, so the
    // handler captures its entries synchronously and resolves the files a
    // microtask later. The fallback below is unchanged for a plain file drop.
    await act(async () => {
      result.current.dragHandlers.onDrop(dropEvent)
    })

    expect(onDrop).toHaveBeenCalledWith([file], { truncated: false, unreadable: 0 })
    expect(result.current.isDragging).toBe(false)
    expect(result.current.isUnsupportedDrag).toBe(false)
    expect(dropEvent.preventDefault).toHaveBeenCalled()
    expect(dropEvent.stopPropagation).toHaveBeenCalled()
  })

  test('does not call onDrop with empty files', async () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const dropEvent = createMockDragEvent([])

    // The drop path is asynchronous now: a DROPPED FOLDER is invisible to
    // `dataTransfer.files` and has to be walked through the entries API, so the
    // handler captures its entries synchronously and resolves the files a
    // microtask later. The fallback below is unchanged for a plain file drop.
    await act(async () => {
      result.current.dragHandlers.onDrop(dropEvent)
    })

    expect(onDrop).not.toHaveBeenCalled()
  })

  test('does not trigger drag events when disabled', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop, disabled: true }))

    const file = new File(['content'], 'test.pdf', { type: 'application/pdf' })
    const enterEvent = createMockDragEvent(
      [file],
      [{ kind: 'file', type: 'application/pdf' } as DataTransferItem]
    )

    act(() => {
      result.current.dragHandlers.onDragEnter(enterEvent)
    })

    // Event handlers still called but state doesn't change
    expect(result.current.isDragging).toBe(false)
  })

  test('does not call onDrop when disabled', async () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop, disabled: true }))

    const file = new File(['content'], 'test.pdf', { type: 'application/pdf' })
    const dropEvent = createMockDragEvent([file])

    // The drop path is asynchronous now: a DROPPED FOLDER is invisible to
    // `dataTransfer.files` and has to be walked through the entries API, so the
    // handler captures its entries synchronously and resolves the files a
    // microtask later. The fallback below is unchanged for a plain file drop.
    await act(async () => {
      result.current.dragHandlers.onDrop(dropEvent)
    })

    expect(onDrop).not.toHaveBeenCalled()
  })

  test('onDragOver prevents default', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const overEvent = createMockDragEvent()

    act(() => {
      result.current.dragHandlers.onDragOver(overEvent)
    })

    expect(overEvent.preventDefault).toHaveBeenCalled()
    expect(overEvent.stopPropagation).toHaveBeenCalled()
  })

  test('handles multiple files on drop', async () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    const files = [
      new File(['content1'], 'test1.pdf', { type: 'application/pdf' }),
      new File(['content2'], 'test2.pdf', { type: 'application/pdf' }),
      new File(['content3'], 'test3.txt', { type: 'text/plain' }),
    ]
    const dropEvent = createMockDragEvent(files)

    // The drop path is asynchronous now: a DROPPED FOLDER is invisible to
    // `dataTransfer.files` and has to be walked through the entries API, so the
    // handler captures its entries synchronously and resolves the files a
    // microtask later. The fallback below is unchanged for a plain file drop.
    await act(async () => {
      result.current.dragHandlers.onDrop(dropEvent)
    })

    expect(onDrop).toHaveBeenCalledWith(files, { truncated: false, unreadable: 0 })
    expect(onDrop).toHaveBeenCalledTimes(1)
  })
})

/**
 * THE UPLOAD SURFACE MUST NOT ANSWER FOR A MOVE.
 *
 * Dragging a document at a folder raised the full-surface "drop files to upload
 * to this project" overlay over the folder it was aimed at, because this hook
 * reacted to any drag with items on it — and an in-app drag has one, our own
 * MIME type. The move underneath still worked; nothing on screen said so.
 */
describe('useFileDragDrop — an in-app drag is not an upload', () => {
  test('ignores a document drag entirely', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    act(() => result.current.dragHandlers.onDragEnter(createInternalDragEvent()))

    expect(result.current.isDragging).toBe(false)
    expect(result.current.isUnsupportedDrag).toBe(false)
  })

  test('ignores a folder drag entirely', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    act(() =>
      result.current.dragHandlers.onDragEnter(
        createInternalDragEvent('application/x-grid-folder-id'),
      ),
    )

    expect(result.current.isDragging).toBe(false)
  })

  test('leaves the drop to the folder under the pointer', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))
    const event = createInternalDragEvent()

    act(() => result.current.dragHandlers.onDrop(event))

    expect(onDrop).not.toHaveBeenCalled()
    // Not claimed as a drop target either: `preventDefault` here would make the
    // whole workspace accept a move, so a document released between two folder
    // tiles would look accepted and do nothing.
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  test('an uncounted leave cannot strand the overlay on the next real upload', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))

    // A move crosses the workspace and leaves it. Neither event is this hook's.
    act(() => result.current.dragHandlers.onDragLeave(createInternalDragEvent()))
    act(() => result.current.dragHandlers.onDragLeave(createInternalDragEvent()))

    // Then a genuine upload arrives. If the leaves above had been subtracted,
    // the counter would be at -2 and one leave would never bring it back to 0.
    act(() => result.current.dragHandlers.onDragEnter(createMockDragEvent([new File(['x'], 'a.pdf')])))
    expect(result.current.isDragging).toBe(true)
    act(() => result.current.dragHandlers.onDragLeave(createMockDragEvent([new File(['x'], 'a.pdf')])))
    expect(result.current.isDragging).toBe(false)
  })
})

/**
 * THE FILE LIST IS ONLY READABLE DURING THE DROP EVENT.
 *
 * The browser empties `dataTransfer.files` once the event has been dispatched.
 * The handler read it as a fallback AFTER the entries traversal had awaited, so
 * an entry whose `file()` fails — an Outlook attachment, a OneDrive file that
 * is only in the cloud — ended in an empty list and a drop that did nothing.
 */
describe('useFileDragDrop — a drop the entries API cannot read', () => {
  function transferThatEmptiesAfterTheEvent(files: File[]): React.DragEvent {
    let dispatching = true
    queueMicrotask(() => {
      dispatching = false
    })
    const failingEntry = {
      isFile: true,
      isDirectory: false,
      name: files[0]?.name ?? '',
      file: (_ok: (file: File) => void, fail: (error: unknown) => void) =>
        setTimeout(() => fail(new Error('NotFoundError')), 0),
    }
    return {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer: {
        types: ['Files'],
        get files() {
          return dispatching ? files : []
        },
        items: files.map(() => ({ kind: 'file', type: 'application/pdf', webkitGetAsEntry: () => failingEntry })),
      },
    } as unknown as React.DragEvent
  }

  test('still uploads the files the event carried', async () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop }))
    const files = [new File(['x'], 'Anhang aus Outlook.pdf', { type: 'application/pdf' })]

    await act(async () => {
      result.current.dragHandlers.onDrop(transferThatEmptiesAfterTheEvent(files))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(onDrop).toHaveBeenCalledWith(files, { truncated: false, unreadable: 0 })
  })
})

/**
 * A zone that is off, a zone that says no, and a drag that ends somewhere else:
 * the three ways the files used to vanish or the overlay used to stay up.
 */
describe('useFileDragDrop — off, refused, and ended elsewhere', () => {
  const pdf = () => [new File(['x'], 'Plan.pdf', { type: 'application/pdf' })]

  test('a disabled zone claims nothing, so the drop falls through to what is around it', () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop, disabled: true }))
    const enter = createMockDragEvent(pdf())
    const over = createMockDragEvent(pdf())
    const drop = createMockDragEvent(pdf())

    act(() => {
      result.current.dragHandlers.onDragEnter(enter)
      result.current.dragHandlers.onDragOver(over)
      result.current.dragHandlers.onDrop(drop)
    })

    for (const event of [enter, over, drop]) {
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(event.stopPropagation).not.toHaveBeenCalled()
    }
    expect(result.current.isDragging).toBe(false)
    expect(onDrop).not.toHaveBeenCalled()
  })

  test('a refusing zone shows its reason, says „no drop" to the cursor, and delivers nothing', async () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDragDrop({ onDrop, refusal: 'Nur lesen' }))
    expect(result.current.refusal).toBeNull()

    const over = createMockDragEvent(pdf())
    act(() => {
      result.current.dragHandlers.onDragEnter(createMockDragEvent(pdf()))
      result.current.dragHandlers.onDragOver(over)
    })
    expect(result.current.isDragging).toBe(true)
    expect(result.current.refusal).toBe('Nur lesen')
    expect(over.preventDefault).toHaveBeenCalled()
    expect(over.dataTransfer.dropEffect).toBe('none')

    const drop = createMockDragEvent(pdf())
    await act(async () => {
      result.current.dragHandlers.onDrop(drop)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(drop.preventDefault).toHaveBeenCalled()
    expect(onDrop).not.toHaveBeenCalled()
    expect(result.current.isDragging).toBe(false)
  })

  test('an accepting zone says „copy"', () => {
    const { result } = renderHook(() => useFileDragDrop({ onDrop: vi.fn() }))
    const over = createMockDragEvent(pdf())
    act(() => result.current.dragHandlers.onDragOver(over))
    expect(over.dataTransfer.dropEffect).toBe('copy')
  })

  test('the overlay clears when the drag ends on another zone, which stops the drop there', () => {
    const { result } = renderHook(() => useFileDragDrop({ onDrop: vi.fn() }))
    act(() => result.current.dragHandlers.onDragEnter(createMockDragEvent(pdf())))
    expect(result.current.isDragging).toBe(true)

    // A folder tile inside the zone claims the drop and stops it; the window
    // still hears it first, in the capture phase.
    const tile = document.createElement('div')
    document.body.appendChild(tile)
    tile.addEventListener('drop', (event) => event.stopPropagation())
    act(() => {
      tile.dispatchEvent(new Event('drop', { bubbles: true }))
    })
    expect(result.current.isDragging).toBe(false)
    tile.remove()
  })

  test('the overlay clears when the drag is cancelled (Escape) or leaves the window', () => {
    const { result } = renderHook(() => useFileDragDrop({ onDrop: vi.fn() }))
    act(() => result.current.dragHandlers.onDragEnter(createMockDragEvent(pdf())))
    act(() => {
      window.dispatchEvent(new Event('dragend'))
    })
    expect(result.current.isDragging).toBe(false)

    act(() => result.current.dragHandlers.onDragEnter(createMockDragEvent(pdf())))
    expect(result.current.isDragging).toBe(true)
    const leave = new MouseEvent('dragleave', { bubbles: true, clientX: 0, clientY: 200, relatedTarget: null })
    act(() => {
      document.body.dispatchEvent(leave)
    })
    expect(result.current.isDragging).toBe(false)
  })

  test('a leave from one child to another inside the window keeps the overlay', () => {
    const { result } = renderHook(() => useFileDragDrop({ onDrop: vi.fn() }))
    act(() => result.current.dragHandlers.onDragEnter(createMockDragEvent(pdf())))
    const leave = new MouseEvent('dragleave', {
      bubbles: true,
      clientX: 200,
      clientY: 200,
      relatedTarget: document.body,
    })
    act(() => {
      document.body.dispatchEvent(leave)
    })
    expect(result.current.isDragging).toBe(true)
  })
})
