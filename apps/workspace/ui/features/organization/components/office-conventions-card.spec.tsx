import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import type { OfficeConventionsView } from '@/lib/office-conventions/office-conventions-wire'
import { OfficeConventionsCard } from './office-conventions-card'

const view = (decision: 'confirmed' | 'declined' | null): OfficeConventionsView => ({
  enabled: true,
  projects: 5,
  computedAt: null,
  lines: [
    {
      line: { kind: 'filing', key: 'filing:gutachten>behörde', docType: 'Gutachten', path: 'Behörde', projects: 4, of: 5 },
      decision,
      counted: true,
      decidedBy: decision ? 'u' : null,
      decidedAt: decision ? '2026-10-22T08:00:00.000Z' : null,
    },
  ],
})

const renderCard = () =>
  render(
    <I18nProvider initialLocale="de" fixedLocale>
      <OfficeConventionsCard />
    </I18nProvider>
  )

afterEach(() => vi.unstubAllGlobals())

describe('OfficeConventionsCard', () => {
  it('shows each line in German with its count and posts the decision', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(view(null)))
      .mockResolvedValueOnce(Response.json(view('declined')))
    vi.stubGlobal('fetch', fetchMock)
    renderCard()
    expect(await screen.findByText('Gutachten werden meist unter Behörde abgelegt.')).toBeTruthy()
    expect(screen.getByText('In 4 von 5 Projekten zu sehen')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Ablehnen' }))

    await waitFor(() => expect(screen.getByText('Abgelehnt')).toBeTruthy())
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ lineKey: 'filing:gutachten>behörde', decision: 'declined' })
    expect(screen.getByRole('button', { name: 'Zurücknehmen' })).toBeTruthy()
  })

  it('says so when nothing is learned', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...view(null), lines: [] })))
    renderCard()
    expect(await screen.findByText(/Noch nichts gelernt/)).toBeTruthy()
  })
})
