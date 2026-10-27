/**
 * The detail opens on the mail (the owner's review, 2026-10-27): one line of
 * who, how far confirmed and when; the evidence (sent time, recipients, the
 * original with its warning, the expiry) one press away behind „Details“;
 * the expiry forward only in its last week; a clean scan silent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/app/projects/p/files/mail',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: vi.fn() }))

import { capturePosthog } from '@/lib/analytics/posthog'
import { render, screen, within } from '@/test-utils'
import { DETAIL_VARIANTS, FIXTURE_NOW, FOLDERS, PROJECT_ID, fixtureClient } from '@/app/dev/inbound-mail/fixtures'
import { expiryShownInline } from '../lib/evidence'
import { InboundMailDetail } from './inbound-mail-detail'

function renderDetail(name: string) {
  const fixture = DETAIL_VARIANTS[name]
  render(
    <InboundMailDetail
      projectId={PROJECT_ID}
      mailId={fixture.view.id}
      initial={fixture.view}
      initialText={fixture.text}
      folders={FOLDERS}
      client={fixtureClient({ detail: fixture })}
      onChanged={vi.fn()}
      now={FIXTURE_NOW}
      pollMs={1}
    />
  )
}

beforeEach(() => vi.clearAllMocks())

describe('MailHeader', () => {
  it('says who, how far confirmed and when in one line, and folds the evidence behind „Details“', async () => {
    renderDetail('member-verified')
    const line = screen.getByTestId('mail-header-line')
    expect(within(line).getByTestId('mail-header-from')).toHaveTextContent('Miriam Huber ‹m.huber@huber-architektur.at›')
    // Trust is never folded away.
    expect(within(line).getByTestId('sender-trust')).toHaveTextContent('Domain verified: huber-architektur.at')
    expect(within(line).getByTestId('mail-header-received')).toBeInTheDocument()
    // The original, its warning, the recipients and the expiry wait behind „Details“.
    expect(screen.queryByTestId('mail-original')).toBeNull()
    expect(screen.queryByText('Opens in your mail program; images from outside are loaded there.')).toBeNull()
    expect(screen.queryByText(/post@ma37\.wien\.gv\.at/)).toBeNull()
    expect(screen.queryByTestId('mail-expires')).toBeNull()

    await userEvent.click(screen.getByTestId('mail-details-toggle'))
    const details = screen.getByTestId('mail-details')
    expect(within(details).getByTestId('mail-original')).toBeInTheDocument()
    expect(details).toHaveTextContent('Opens in your mail program; images from outside are loaded there.')
    expect(details).toHaveTextContent('Sent')
    expect(details).toHaveTextContent('post@ma37.wien.gv.at')
    expect(within(details).getByTestId('mail-expires')).toHaveTextContent('then it expires')
    expect(capturePosthog).toHaveBeenCalledWith('inbound_mail_details_opened', { status: 'waiting', risk_level: 'none' })
  })

  it('puts the text right after the header, before any part can be checked', () => {
    renderDetail('member-verified')
    const header = screen.getByTestId('mail-header')
    const text = screen.getByText(/der Bescheid zum Stellplatznachweis ist gestern gekommen/)
    const checkbox = screen.getByTestId('attachment-checkbox')
    expect(header.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(text.compareDocumentPosition(checkbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('brings the expiry forward only in its last week', () => {
    renderDetail('expires-soon')
    expect(screen.getByTestId('mail-expires-soon')).toHaveTextContent('Waits only until')
  })

  it('keeps a month-away expiry in „Details“', () => {
    renderDetail('member-verified')
    expect(screen.queryByTestId('mail-expires-soon')).toBeNull()
  })

  it('is silent about a clean scan and speaks when one runs or failed', () => {
    renderDetail('member-verified')
    expect(screen.queryByText('Checked for malware')).toBeNull()
    expect(screen.queryByTestId('status-scan-pending')).toBeNull()
  })

  it('says a running and a failed scan on their rows', () => {
    renderDetail('scan-pending')
    expect(screen.getByTestId('status-scan-pending')).toBeInTheDocument()
    expect(screen.getByTestId('status-scan-failed')).toBeInTheDocument()
  })
})

describe('expiryShownInline', () => {
  const day = 86_400_000
  it('is true for a waiting mail with fewer than seven days left', () => {
    expect(expiryShownInline({ status: 'waiting', expiresAt: new Date(FIXTURE_NOW + 6.9 * day).toISOString() }, FIXTURE_NOW)).toBe(true)
  })
  it('is false at seven days or more, and for a handled mail', () => {
    expect(expiryShownInline({ status: 'waiting', expiresAt: new Date(FIXTURE_NOW + 7 * day).toISOString() }, FIXTURE_NOW)).toBe(false)
    expect(expiryShownInline({ status: 'handled', expiresAt: new Date(FIXTURE_NOW + day).toISOString() }, FIXTURE_NOW)).toBe(false)
  })
})
