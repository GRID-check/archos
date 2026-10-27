/**
 * Which mail brought a Fassung (D36): the line names the sender and the day,
 * says how far the domain was confirmed in the tab's three words, and opens
 * the thread document at the entry; the header row speaks for the NEWEST
 * Fassung only and says nothing when no mail brought it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

const push = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/app/projects/p/files',
  useSearchParams: () => new URLSearchParams(),
}))

import { toast } from 'sonner'
import { render, screen, waitFor } from '@/test-utils'
import { MAIL_THREAD_VARIANTS, PROJECT_ID, PROVENANCE_ORIGINS, THREAD_DOCUMENT_ID, fixtureMailThreadClient, origin, versions } from '@/app/dev/mail-thread/fixtures'
import { MailOriginLine, mailEntryHref, useOpenMailOrigin } from './mail-origin-line'
import { MailProvenanceRow, newestVersionOrigins } from './mail-provenance-row'
import type { MailThreadClient } from './client'

beforeEach(() => vi.clearAllMocks())

describe('MailOriginLine', () => {
  it('names the sender, the day and the confirmed domain', () => {
    render(<MailOriginLine origins={PROVENANCE_ORIGINS.verified} />)
    const line = screen.getByTestId('mail-origin')
    expect(line).toHaveTextContent(/^Came with the mail from DI Petra Weber on Oct 9, 2026/)
    expect(screen.getByTestId('mail-origin-trust')).toHaveTextContent('Domain verified: statik-weber.at')
    expect(screen.queryByTestId('mail-origin-open')).toBeNull()
  })

  it('never lets an unconfirmed or archived sender read as confirmed', () => {
    const { unmount } = render(<MailOriginLine origins={PROVENANCE_ORIGINS.unverified} />)
    expect(screen.getByTestId('mail-origin').dataset.trust).toBe('unverified')
    expect(screen.getByTestId('mail-origin-trust')).toHaveTextContent('Domain not verified')
    unmount()
    render(<MailOriginLine origins={PROVENANCE_ORIGINS.archive} />)
    expect(screen.getByTestId('mail-origin-trust')).toHaveTextContent('From the mail archive · not checked')
  })

  it('counts further mails and says a nameless one without a name', () => {
    const { unmount } = render(<MailOriginLine origins={PROVENANCE_ORIGINS.several} />)
    expect(screen.getByTestId('mail-origin')).toHaveTextContent('+1 more')
    unmount()
    render(<MailOriginLine origins={PROVENANCE_ORIGINS.anonymous} />)
    expect(screen.getByTestId('mail-origin')).toHaveTextContent(/^Came with a mail on /)
  })
})

function Opener({ client }: { client: MailThreadClient }) {
  const open = useOpenMailOrigin(PROJECT_ID, client)
  return <MailOriginLine origins={[origin()]} onOpen={open} />
}

describe('„Im E-Mail-Verlauf ansehen“', () => {
  it('opens the thread document in Dateien at the entry', async () => {
    const client = fixtureMailThreadClient(MAIL_THREAD_VARIANTS['three-messages'])
    render(<Opener client={client} />)
    await userEvent.click(screen.getByTestId('mail-origin-open'))
    await waitFor(() => expect(push).toHaveBeenCalledWith(mailEntryHref(PROJECT_ID, THREAD_DOCUMENT_ID, origin().entryId)))
    expect(mailEntryHref('p 1', 'd', 'e')).toBe('/app/projects/p%201/files?doc=d&mailEntry=e')
  })

  it('says so when the reader may no longer see the thread', async () => {
    const client = fixtureMailThreadClient(MAIL_THREAD_VARIANTS.error)
    render(<Opener client={client} />)
    await userEvent.click(screen.getByTestId('mail-origin-open'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The mail thread cannot be opened. You may no longer see it.'))
    expect(push).not.toHaveBeenCalled()
  })
})

describe('the header row', () => {
  it('speaks for the newest Fassung only', () => {
    const documentVersions = versions(3)
    expect(newestVersionOrigins([{ ...documentVersions[0], mailOrigins: [origin()] }, documentVersions[1], documentVersions[2]])).toEqual([])
    expect(newestVersionOrigins([documentVersions[0], { ...documentVersions[2], mailOrigins: [origin()] }, documentVersions[1]])).toEqual([origin()])
  })

  it('shows the mail that brought the Fassung, and nothing for a document no mail brought', async () => {
    const base = fixtureMailThreadClient(MAIL_THREAD_VARIANTS['three-messages'])
    const withOrigin: MailThreadClient = {
      ...base,
      versions: async () => ({ documentId: 'd', lifecycle: 'active', publishedVersionId: null, versions: [{ ...versions(1)[0], mailOrigins: [origin()] }] }),
    }
    const { unmount } = render(<MailProvenanceRow projectId={PROJECT_ID} documentId="d" client={withOrigin} />)
    expect(await screen.findByTestId('mail-provenance-row')).toHaveTextContent('Came with the mail from DI Petra Weber')
    unmount()
    render(<MailProvenanceRow projectId={PROJECT_ID} documentId="d" client={base} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByTestId('mail-provenance-row')).toBeNull()
  })
})
