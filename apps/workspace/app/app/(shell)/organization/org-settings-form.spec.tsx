/**
 * Organization settings: the web-search switch is saved through its own route,
 * the one an agent calls (`organization-web-search-set`), never through the
 * generic settings save, which refuses the key.
 */

import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))

import { OrgSettingsForm } from './org-settings-form'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const form = () => (
  <OrgSettingsForm initialDisplayName="Büro Nord" initialDefaultLocale="de" initialWebSearchEnabled initialChatEffort="medium" />
)

const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }))

describe('the web-search switch', () => {
  test('is saved through the web-search route, and never in the settings bag', async () => {
    const user = userEvent.setup()
    render(form())
    await user.click(screen.getByRole('switch', { name: /web search/i }))
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [settings, webSearch] = calls()
    expect(settings.url).toBe('/api/organization/settings')
    expect(settings.body.settings).not.toHaveProperty('webSearchEnabled')
    expect(webSearch).toEqual({ url: '/api/organization/web-search', body: { enabled: false } })
  })

  test('leaves the web-search route alone when the switch did not move', async () => {
    const user = userEvent.setup()
    render(form())
    await user.clear(screen.getByLabelText(/display name/i))
    await user.type(screen.getByLabelText(/display name/i), 'Büro Süd')
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(calls()[0]?.url).toBe('/api/organization/settings')
  })
})
