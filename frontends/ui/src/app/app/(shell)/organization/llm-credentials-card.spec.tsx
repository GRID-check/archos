import { render, screen, waitFor } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LlmCredentialsCard } from './llm-credentials-card'
import { buildSessionRecordingOptions } from '@/lib/analytics/posthog'
import { REPLAY_BLOCK_CLASS } from '@/lib/analytics/posthog-config'

vi.mock('posthog-js', () => ({ default: {} }))

/**
 * The BYOK key is the one value in the product that is a credential for a
 * third party. Autocapture and the session recorder must not be able to see it,
 * whatever else about their configuration changes.
 */
describe('LlmCredentialsCard BYOK key input', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ credentials: [], mode: 'byok', secretBackend: 'local' })
      )
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const keyInput = async (): Promise<HTMLElement> => {
    render(<LlmCredentialsCard />)
    await waitFor(() => expect(document.getElementById('byok-api-key')).not.toBeNull())
    return document.getElementById('byok-api-key')!
  }

  test('carries ph-no-capture and data-ph-no-capture', async () => {
    const input = await keyInput()
    expect(input).toHaveClass(REPLAY_BLOCK_CLASS)
    expect(input).toHaveAttribute('data-ph-no-capture')
    expect(input).toHaveAttribute('type', 'password')
  })

  test('is matched by the recorder block selector, so a replay draws a placeholder instead', async () => {
    const input = await keyInput()
    expect(screen.getByLabelText(/api/i)).toBe(input)
    const selector = buildSessionRecordingOptions(1).blockSelector ?? ''
    expect(selector.split(', ')).toContain('[data-ph-no-capture]')
    expect(input.matches('[data-ph-no-capture]')).toBe(true)
  })
})
