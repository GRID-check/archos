import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SubmitProductFeedbackRequest, SubmitProductFeedbackResult } from '@/lib/product-feedback/client'
import { capturePosthog, getPosthogSupportContext } from '@/lib/analytics/posthog'
import { FeedbackForm } from './feedback-form'

vi.mock('@/lib/analytics/posthog', () => ({
  capturePosthog: vi.fn(),
  getPosthogSupportContext: vi.fn(() => ({ sessionId: '0199d7f2-5b3a-7c4e-9a1d-3e8f2b6c5d70' })),
}))

const ok: SubmitProductFeedbackResult = {
  ok: true,
  report: { id: 'r1', kind: 'bug', createdAt: '2026-09-29T08:00:00Z' },
}

function setup(result: SubmitProductFeedbackResult = ok) {
  const submit = vi.fn<(request: SubmitProductFeedbackRequest) => Promise<SubmitProductFeedbackResult>>()
  submit.mockResolvedValue(result)
  const onSent = vi.fn()
  const onCancel = vi.fn()
  render(<FeedbackForm submit={submit} onSent={onSent} onCancel={onCancel} userEmail="maria@buero.test" />)
  return { submit, onSent, onCancel, user: userEvent.setup() }
}

const message = () => screen.getByTestId('feedback-message')
const send = () => screen.getByTestId('feedback-send')

describe('FeedbackForm', () => {
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

  test('hands the stored report to the host, which opens its thread', async () => {
    const { onSent, user } = setup()

    await user.type(message(), 'The upload stops at 99 percent.')
    await user.click(send())

    await waitFor(() => expect(onSent).toHaveBeenCalledWith('r1'))
  })

  test('Cancel hands back to the host without sending', async () => {
    const { submit, onCancel, user } = setup()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledOnce()
    expect(submit).not.toHaveBeenCalled()
  })

  test('keeps the text and explains when sending fails', async () => {
    const { onSent, user } = setup({ ok: false, reason: 'rate-limited' })

    await user.type(message(), 'The upload stops at 99 percent.')
    await user.click(send())

    expect(await screen.findByRole('alert')).toHaveTextContent('a lot of feedback in the last hour')
    expect(message()).toHaveValue('The upload stops at 99 percent.')
    expect(onSent).not.toHaveBeenCalled()
  })

  test('says where a reply would go', () => {
    setup()
    expect(screen.getByText(/maria@buero\.test/)).toBeInTheDocument()
  })

  describe('PostHog', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    test('hands the server the PostHog replay session, so the ticket links the recording', async () => {
      const { submit, user } = setup()

      await user.type(message(), 'The upload stops at 99 percent.')
      await user.click(send())

      await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
      expect(submit.mock.calls[0]![0].posthog).toEqual({ sessionId: '0199d7f2-5b3a-7c4e-9a1d-3e8f2b6c5d70' })
    })

    test('sends the product event with the kind and never the words', async () => {
      const { user } = setup({
        ok: true,
        report: { id: 'r7', kind: 'idea', createdAt: '2026-09-29T08:00:00Z' },
      })

      await user.click(screen.getByRole('radio', { name: /Idea/ }))
      await user.type(message(), 'Please add an export for the Honorar 48.000 EUR.')
      await user.click(send())

      await waitFor(() =>
        expect(capturePosthog).toHaveBeenCalledWith('product_feedback_submitted', { kind: 'idea' }),
      )
      expect(JSON.stringify(vi.mocked(capturePosthog).mock.calls)).not.toMatch(/Honorar/)
    })

    test('still sends with no PostHog state when PostHog is off in this browser', async () => {
      vi.mocked(getPosthogSupportContext).mockReturnValueOnce({ sessionId: null })
      const { submit, onSent, user } = setup()

      await user.type(message(), 'The upload stops at 99 percent.')
      await user.click(send())

      await waitFor(() => expect(onSent).toHaveBeenCalledWith('r1'))
      expect(submit.mock.calls[0]![0].posthog).toEqual({ sessionId: null })
    })

    test('does not involve PostHog when the report was not stored', async () => {
      const { user } = setup({ ok: false, reason: 'failed' })

      await user.type(message(), 'The upload stops at 99 percent.')
      await user.click(send())

      await screen.findByRole('alert')
      expect(capturePosthog).not.toHaveBeenCalled()
    })
  })
})

describe('FeedbackForm on a phone', () => {
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
