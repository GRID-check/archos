/**
 * Getting an answer out of the app from a phone: the share sheet.
 *
 * jsdom has no `pointer: coarse` and no `navigator.share`, so each test states
 * its device. The contract: the share button exists only where there is a sheet
 * AND a finger, hands over the answer (sources written out when the turn has
 * them), and falls back to the copy rather than failing silently.
 */

import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { AnswerActions } from './AnswerActions'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: vi.fn() }))
vi.mock('@/lib/browser-download', () => ({ startBrowserDownload: vi.fn() }))

const ANSWER = 'Die Fluchtweglänge ist auf **40 m** begrenzt [1].'

function device({ coarse, share }: { coarse: boolean; share?: ReturnType<typeof vi.fn> }) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse && query.includes('coarse'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  })
  Object.defineProperty(navigator, 'share', { configurable: true, writable: true, value: share })
}

describe('AnswerActions: native share', () => {
  const originalMatchMedia = window.matchMedia
  const originalShare = Object.getOwnPropertyDescriptor(navigator, 'share')

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    if (originalShare) Object.defineProperty(navigator, 'share', originalShare)
    else Reflect.deleteProperty(navigator, 'share')
  })

  test('a phone with a share sheet gets the button, and it hands over the answer', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    device({ coarse: true, share })
    const user = userEvent.setup()
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={[]} />)

    await user.click(screen.getByTestId('answer-share'))

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1))
    const shared = share.mock.calls[0]![0] as { title: string; text: string }
    expect(shared.title).toBe('Answer from Piloti')
    expect(shared.text).toContain('**40 m**')
  })

  test('the button is 44px on a finger', () => {
    device({ coarse: true, share: vi.fn() })
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={[]} />)

    expect(screen.getByTestId('answer-share').className).toContain('pointer-coarse:size-11')
  })

  test('a desktop gets no share button even when the browser has a share sheet', () => {
    device({ coarse: false, share: vi.fn() })
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={[]} />)

    expect(screen.queryByTestId('answer-share')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy answer' })).toBeInTheDocument()
  })

  test('a phone browser without a share sheet keeps the copy as its way out', () => {
    device({ coarse: true })
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={[]} />)

    expect(screen.queryByTestId('answer-share')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy answer' })).toBeInTheDocument()
  })

  test('a refused share falls back to the clipboard', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('gesture', 'NotAllowedError'))
    device({ coarse: true, share })
    const writeText = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={[]} />)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })

    await user.click(screen.getByTestId('answer-share'))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0]![0]).toContain('**40 m**')
    expect(toastError).not.toHaveBeenCalled()
  })

  test('closing the sheet copies nothing and says nothing', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('closed', 'AbortError'))
    device({ coarse: true, share })
    const writeText = vi.fn()
    const user = userEvent.setup()
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={[]} />)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })

    await user.click(screen.getByTestId('answer-share'))

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1))
    expect(writeText).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  test('the footnote buttons do not borrow overlapping catchments', () => {
    device({ coarse: true, share: vi.fn() })
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={[]} conversationId="c" messageId="m" />)

    for (const name of ['Copy answer', 'Download as Word document']) {
      const className = screen.getByRole('button', { name }).className
      expect(className).toContain('pointer-coarse:size-11')
      expect(className).not.toContain('touch-target')
    }
  })
})
