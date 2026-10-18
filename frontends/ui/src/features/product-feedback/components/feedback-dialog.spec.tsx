import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SubmitProductFeedbackRequest, SubmitProductFeedbackResult } from '@/lib/product-feedback/client'
import { capturePosthog, sendPosthogSupportMessage } from '@/lib/analytics/posthog'
import { FeedbackDialog } from './feedback-dialog'

vi.mock('@/lib/analytics/posthog', () => ({
  capturePosthog: vi.fn(),
  sendPosthogSupportMessage: vi.fn(async () => true),
}))

const ok: SubmitProductFeedbackResult = {
  ok: true,
  report: { id: 'r1', kind: 'bug', createdAt: '2026-09-29T08:00:00Z', relayText: 'The upload stops at 99 percent.' },
}

function setup(result: SubmitProductFeedbackResult = ok) {
  const submit = vi.fn<(request: SubmitProductFeedbackRequest) => Promise<SubmitProductFeedbackResult>>()
  submit.mockResolvedValue(result)
  const onOpenChange = vi.fn()
  render(
    <FeedbackDialog open onOpenChange={onOpenChange} submit={submit} userEmail="maria@buero.test" />,
  )
  return { submit, onOpenChange, user: userEvent.setup() }
}

const message = () => screen.getByTestId('feedback-message')
const send = () => screen.getByTestId('feedback-send')

describe('FeedbackDialog', () => {
  test('sends the kind, the trimmed message, the contact choice and the captured page', async () => {
    const { submit, user } = setup()

    await user.click(screen.getByRole('radio', { name: /Idea/ }))
    await user.type(message(), '  Please add an export for plan lists.  ')
    await user.click(screen.getByRole('checkbox', { name: 'You may contact me about this' }))
    await user.click(send())

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const request = submit.mock.calls[0]![0]
    expect(request).toMatchObject({
      kind: 'idea',
      message: 'Please add an export for plan lists.',
      allowContact: false,
      pagePath: '/',
    })
    expect(request.context.viewport).toMatch(/\d+×\d+/)
  })

  test('opens on a bug, the kind most people come to report', () => {
    setup()
    expect(screen.getByRole('radio', { name: /Bug/ })).toHaveAttribute('aria-checked', 'true')
  })

  test('refuses a message too short to act on, without sending', async () => {
    const { submit, user } = setup()

    await user.type(message(), 'Bug')
    await user.click(send())

    expect(await screen.findByRole('alert')).toHaveTextContent('at least 10 characters')
    expect(submit).not.toHaveBeenCalled()
  })

  test('sends on ⌘/Ctrl + Enter', async () => {
    const { submit, user } = setup()

    await user.type(message(), 'The upload stops at 99 percent.')
    await user.keyboard('{Control>}{Enter}{/Control}')

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  })

  test('thanks the reporter once it is sent', async () => {
    const { user } = setup()

    await user.type(message(), 'The upload stops at 99 percent.')
    await user.click(send())

    expect(await screen.findByTestId('feedback-sent')).toHaveTextContent('Thank you!')
  })

  test('keeps the text and explains when sending fails', async () => {
    const { user } = setup({ ok: false, reason: 'rate-limited' })

    await user.type(message(), 'The upload stops at 99 percent.')
    await user.click(send())

    expect(await screen.findByRole('alert')).toHaveTextContent('a lot of feedback in the last hour')
    expect(message()).toHaveValue('The upload stops at 99 percent.')
  })

  test('says where a reply would go', () => {
    setup()
    expect(screen.getByText(/maria@buero\.test/)).toBeInTheDocument()
  })

  describe('PostHog', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    test('opens a Support ticket with the report id and the masked text the server returned', async () => {
      const { user } = setup({
        ok: true,
        report: {
          id: 'r7',
          kind: 'idea',
          createdAt: '2026-09-29T08:00:00Z',
          relayText: 'Please add an export for [Honorar maskiert].',
        },
      })

      await user.click(screen.getByRole('radio', { name: /Idea/ }))
      await user.type(message(), 'Please add an export for the Honorar 48.000 EUR.')
      await user.click(send())

      await waitFor(() => expect(sendPosthogSupportMessage).toHaveBeenCalledTimes(1))
      // The typed words never go: the ticket carries what the server masked.
      expect(sendPosthogSupportMessage).toHaveBeenCalledWith(
        '[idea] #r7 /\nPlease add an export for [Honorar maskiert].',
      )
      // The event carries the kind and never the words.
      expect(capturePosthog).toHaveBeenCalledWith('product_feedback_submitted', { kind: 'idea' })
    })

    test('opens no ticket when the server returned no text to relay (contact not allowed)', async () => {
      const { user } = setup({
        ok: true,
        report: { id: 'r8', kind: 'bug', createdAt: '2026-09-29T08:00:00Z', relayText: null },
      })

      await user.type(message(), 'The upload stops at 99 percent.')
      await user.click(screen.getByRole('checkbox', { name: 'You may contact me about this' }))
      await user.click(send())

      expect(await screen.findByTestId('feedback-sent')).toBeInTheDocument()
      expect(sendPosthogSupportMessage).not.toHaveBeenCalled()
      expect(capturePosthog).toHaveBeenCalledWith('product_feedback_submitted', { kind: 'bug' })
    })

    test('does not involve PostHog when the report was not stored', async () => {
      const { user } = setup({ ok: false, reason: 'failed' })

      await user.type(message(), 'The upload stops at 99 percent.')
      await user.click(send())

      await screen.findByRole('alert')
      expect(sendPosthogSupportMessage).not.toHaveBeenCalled()
      expect(capturePosthog).not.toHaveBeenCalled()
    })

    test('still thanks the reporter when PostHog Support is unavailable', async () => {
      vi.mocked(sendPosthogSupportMessage).mockResolvedValueOnce(false)
      const { user } = setup()

      await user.type(message(), 'The upload stops at 99 percent.')
      await user.click(send())

      expect(await screen.findByTestId('feedback-sent')).toBeInTheDocument()
    })
  })
})

describe('FeedbackDialog on a phone', () => {
  const coarse = (matches: boolean): void => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) => ({
        matches: matches && query === '(pointer: coarse)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    )
  }

  test('does not raise the keyboard on open, so the kinds and the send button stay visible', () => {
    coarse(true)
    setup()
    expect(message()).not.toHaveFocus()
    vi.unstubAllGlobals()
  })

  test('with a mouse the message takes focus, as it always did', async () => {
    coarse(false)
    setup()
    await waitFor(() => expect(message()).toHaveFocus())
    vi.unstubAllGlobals()
  })

  test('the keyboard-shortcut hint is not painted where there is no keyboard', () => {
    setup()
    expect(document.getElementById(`${message().id}-hint`)?.className).toMatch(/pointer-coarse:hidden/)
  })
})
