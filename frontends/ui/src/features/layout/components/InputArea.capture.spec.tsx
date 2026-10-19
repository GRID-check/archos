/**
 * Capture from the composer: the attach menu a touch screen opens (camera,
 * photo library, documents), what each input accepts, the name a site photo
 * is uploaded under, and the microphone that says why it cannot record.
 *
 * The upload hook is faked; the photo preparation, the inputs and the menu are
 * real. jsdom has no `matchMedia`, so the pointer kind is stubbed per test.
 */
import { act, fireEvent, render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FileUploadConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))
vi.mock('@/features/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/chat')>()),
  useWebSocketChat: vi.fn(() => ({
    sendMessage: vi.fn(),
    isStreaming: false,
    isLoading: false,
    respondToInteraction: vi.fn(),
    noteSendIntent: vi.fn(),
    pendingInteraction: null,
  })),
  useIsCurrentSessionBusy: vi.fn(() => false),
}))
vi.mock('@/adapters/auth', () => ({ useAuth: () => ({ idToken: 'test-token', authRequired: true }) }))

const upload = vi.hoisted(() => ({ config: null as FileUploadConfig | null }))
vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({ authRequired: true, fileUpload: upload.config }),
}))

const mockUploadFiles = vi.fn()
vi.mock('@/features/documents', () => ({
  useFileUpload: vi.fn(() => ({
    uploadFiles: mockUploadFiles,
    sessionFiles: [],
    deleteFile: vi.fn(),
    retryFile: vi.fn(),
    isUploading: false,
    error: null,
    clearError: vi.fn(),
  })),
  useFileDragDrop: vi.fn(() => ({
    isDragging: false,
    isUnsupportedDrag: false,
    dragHandlers: { onDragEnter: vi.fn(), onDragLeave: vi.fn(), onDragOver: vi.fn(), onDrop: vi.fn() },
  })),
}))
vi.mock('./FileSourcesTab', () => ({ FileSourcesTab: () => null }))
vi.mock('@/features/documents/components/file-preview-dialog', () => ({ FilePreviewDialog: () => null }))

import { useChatStore } from '@/features/chat'
import { useLayoutStore } from '../store'
import { InputArea } from './InputArea'

const PHOTOS_ON = getFileUploadConfigFromEnv({}, { imageUploadEnabled: true, vlmAvailable: true })
const NO_VISION = getFileUploadConfigFromEnv({}, { imageUploadEnabled: true, vlmAvailable: false })

const pointer = (coarse: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: coarse && query === '(pointer: coarse)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList
  )

beforeEach(() => {
  upload.config = PHOTOS_ON
  mockUploadFiles.mockReset()
  // Uploads are offered only where the knowledge layer answers.
  useLayoutStore.setState({ knowledgeLayerAvailable: true })
  // The conversation row an attachment needs; no server here.
  useChatStore.setState({
    ensureSession: () => 'session-1',
    _ensureConversationExists: vi.fn(async () => undefined),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const attach = () => screen.getByTestId('composer-attach')
const input = (testId: string) => screen.getByTestId(testId) as HTMLInputElement

/** Radix opens a menu on a pointer press, which `user.click` delivers. */
async function openAttachMenu() {
  const user = userEvent.setup()
  await user.click(attach())
  return screen.findByTestId('composer-attach-menu')
}

describe('attaching on a touch screen', () => {
  test('the paperclip opens camera, photo library and documents, and says where they land', async () => {
    pointer(true)
    render(<InputArea isAuthenticated={true} />)

    const menu = await openAttachMenu()

    expect(menu).toHaveTextContent('Take photo')
    expect(menu).toHaveTextContent('From photo library')
    expect(menu).toHaveTextContent('Choose file')
    expect(menu).toHaveTextContent('Lands in this chat only.')
  })

  test('the camera input opens the rear camera, with explicit image types so iOS sends JPEG', () => {
    pointer(true)
    render(<InputArea isAuthenticated={true} />)

    const camera = input('composer-camera-input')
    expect(camera.getAttribute('capture')).toBe('environment')
    expect(camera.accept).toBe('image/png,image/jpeg,image/webp')
    expect(camera.multiple).toBe(false)
    expect(input('composer-library-input').accept).toBe('image/png,image/jpeg,image/webp')
    expect(input('composer-library-input').multiple).toBe(true)
  })

  test('„Choose file" offers documents only, so iOS does not ask for the photo choice a second time', () => {
    pointer(true)
    render(<InputArea isAuthenticated={true} />)

    const accept = input('composer-file-input').accept.split(',')
    expect(accept).toContain('.pdf')
    expect(accept).not.toContain('.jpg')
    expect(accept).not.toContain('.png')
  })

  test('choosing „Take photo" opens the camera input', async () => {
    pointer(true)
    render(<InputArea isAuthenticated={true} />)
    const clicked = vi.spyOn(input('composer-camera-input'), 'click').mockImplementation(() => {})

    await openAttachMenu()
    fireEvent.click(screen.getByTestId('composer-attach-camera'))

    await waitFor(() => expect(clicked).toHaveBeenCalled())
  })

  test('without a vision model the photo entries stay, disabled, and the menu says why', async () => {
    pointer(true)
    upload.config = NO_VISION
    render(<InputArea isAuthenticated={true} />)

    const menu = await openAttachMenu()

    expect(screen.getByTestId('composer-attach-camera')).toHaveAttribute('data-disabled')
    expect(screen.getByTestId('composer-attach-library')).toHaveAttribute('data-disabled')
    expect(menu).toHaveTextContent('Piloti needs an image model to read them')
    expect(screen.queryByTestId('composer-camera-input')).not.toBeInTheDocument()
  })
})

describe('attaching with a mouse', () => {
  test('the paperclip is one action: the file picker with every accepted type, photos included', () => {
    pointer(false)
    render(<InputArea isAuthenticated={true} />)
    const picker = input('composer-file-input')
    const clicked = vi.spyOn(picker, 'click').mockImplementation(() => {})

    fireEvent.click(attach())

    expect(clicked).toHaveBeenCalled()
    expect(screen.queryByTestId('composer-attach-menu')).not.toBeInTheDocument()
    expect(picker.accept.split(',')).toEqual(expect.arrayContaining(['.pdf', '.jpg', '.png']))
  })
})

describe('a site photo is uploaded under a name of its own', () => {
  test('a camera capture iOS calls image.jpg goes up as „Photo <when it was taken>"', async () => {
    pointer(true)
    render(<InputArea isAuthenticated={true} />)
    const taken = new Date(2026, 9, 15, 14, 32, 5).getTime()
    const capture = new File(['jpeg'], 'image.jpg', { type: 'image/jpeg', lastModified: taken })

    await act(async () => {
      fireEvent.change(input('composer-camera-input'), { target: { files: [capture] } })
    })

    await waitFor(() => expect(mockUploadFiles).toHaveBeenCalled())
    const [files] = mockUploadFiles.mock.calls[0]! as [File[]]
    expect(files.map((file) => file.name)).toEqual(['Photo 2026-10-15 14-32-05.jpg'])
  })
})

describe('a microphone this browser cannot use', () => {
  // jsdom has no MediaRecorder, so the microphone is unavailable here.
  test('a press says why under the composer, where a touch screen can read it', async () => {
    pointer(true)
    render(<InputArea isAuthenticated={true} />)

    fireEvent.click(await screen.findByTestId('dictation-unavailable'))

    expect(screen.getByRole('status')).toHaveTextContent('This browser cannot record from a microphone.')
  })
})
