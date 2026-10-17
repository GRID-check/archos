/**
 * The chat panel is the drop target, not the composer card: a file let go over
 * the transcript is attached, and while attaching is closed the panel says why.
 */
import { act, fireEvent, render, screen, waitFor } from '@/test-utils'
import { describe, expect, test, vi } from 'vitest'
import { ChatDropZone, useChatDropTarget, type ChatDropTarget } from './chat-drop-zone'
import { composerDropRefusal } from '../lib/composer-drop-refusal'

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

const plan = new File(['%PDF'], 'Grundriss.pdf', { type: 'application/pdf' })
const transfer = (files: File[]) => ({ types: ['Files'], files, items: [] })

/** A composer stand-in: it only registers, as InputArea does. */
function Composer({ target }: { target: ChatDropTarget | null }) {
  useChatDropTarget(target)
  return <p>Composer</p>
}

function Panel({ target }: { target: ChatDropTarget | null }) {
  return (
    <ChatDropZone>
      <p>Transcript</p>
      <Composer target={target} />
    </ChatDropZone>
  )
}

describe('ChatDropZone', () => {
  test('attaches a file let go over the transcript', async () => {
    const attach = vi.fn()
    render(<Panel target={{ attach, refusal: null }} />)

    fireEvent.dragEnter(screen.getByText('Transcript'), { dataTransfer: transfer([plan]) })
    expect(screen.getByTestId('chat-drop-overlay')).toHaveTextContent('Drop files to upload')
    fireEvent.drop(screen.getByText('Transcript'), { dataTransfer: transfer([plan]) })

    await waitFor(() => expect(attach).toHaveBeenCalledWith([plan]))
  })

  test('says why while attaching is closed, and attaches nothing', async () => {
    const attach = vi.fn()
    render(<Panel target={{ attach, refusal: 'Piloti is answering.' }} />)

    fireEvent.dragEnter(screen.getByText('Transcript'), { dataTransfer: transfer([plan]) })
    const overlay = screen.getByTestId('chat-drop-overlay')
    expect(overlay).toHaveTextContent('Piloti is answering.')
    expect(overlay).toHaveAttribute('data-refused')
    fireEvent.drop(screen.getByText('Transcript'), { dataTransfer: transfer([plan]) })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(attach).not.toHaveBeenCalled()
  })

  test('is no target without a composer: the drop is left to the window guard', () => {
    render(<Panel target={null} />)

    fireEvent.dragEnter(screen.getByText('Transcript'), { dataTransfer: transfer([plan]) })
    expect(screen.queryByTestId('chat-drop-overlay')).toBeNull()
    // `fireEvent` answers false when a handler cancelled the event.
    expect(fireEvent.drop(screen.getByText('Transcript'), { dataTransfer: transfer([plan]) })).toBe(true)
  })

  test('attaches through the latest attach path, not the one first registered', async () => {
    const first = vi.fn()
    const latest = vi.fn()
    const { rerender } = render(<Panel target={{ attach: first, refusal: null }} />)
    rerender(<Panel target={{ attach: latest, refusal: null }} />)

    fireEvent.drop(screen.getByText('Transcript'), { dataTransfer: transfer([plan]) })

    await waitFor(() => expect(latest).toHaveBeenCalledWith([plan]))
    expect(first).not.toHaveBeenCalled()
  })
})

describe('composerDropRefusal', () => {
  const open = {
    canContribute: true,
    isStreaming: false,
    awaitsAnswer: false,
    isUploading: false,
    knowledgeLayerAvailable: true,
  }

  test('takes a drop when the paperclip would', () => {
    expect(composerDropRefusal(open)).toBeNull()
  })

  test('names the fact that closes the paperclip', () => {
    expect(composerDropRefusal({ ...open, canContribute: false })).toBe('dropRefusedReadOnly')
    expect(composerDropRefusal({ ...open, isStreaming: true })).toBe('dropRefusedAnswering')
    expect(composerDropRefusal({ ...open, isStreaming: true, awaitsAnswer: true })).toBe('dropRefusedQuestion')
    expect(composerDropRefusal({ ...open, isUploading: true })).toBe('dropRefusedUploading')
    expect(composerDropRefusal({ ...open, knowledgeLayerAvailable: false })).toBe('uploadNotAvailable')
  })
})
