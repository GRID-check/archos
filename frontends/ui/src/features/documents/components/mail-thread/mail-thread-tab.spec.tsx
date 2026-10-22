/**
 * The „E-Mails“ tab, as a person uses it: the mails newest first with the
 * Fassung each first appeared in; what came with each; the original's states,
 * including the 409 a download can still answer; following, renewing and
 * stopping; a manager ending someone else's follow and nobody else seeing
 * „Beenden“; „Vergleichen“; a detach that names the Fassungen keeping the mail
 * and says a refusal in the dialog; a link scrolling to its entry.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/app/projects/p/files',
  useSearchParams: () => new URLSearchParams(),
}))

import { toast } from 'sonner'
import { render, screen, waitFor, within } from '@/test-utils'
import {
  MAIL_THREAD_VARIANTS,
  PROJECT_ID,
  THREAD_DOCUMENT_ID,
  THREAD_FOLDER_ID,
  VIEWER_ID,
  fixtureMailThreadClient,
  type MailThreadFixture,
} from '@/app/dev/mail-thread/fixtures'
import type { MailThreadClient } from './client'
import { MailThreadTab } from './mail-thread-tab'

function renderTab(name: string, options: { client?: MailThreadClient; viewer?: string | null; focus?: { entryId?: string } } = {}) {
  const fixture: MailThreadFixture = MAIL_THREAD_VARIANTS[name]
  const client = options.client ?? fixtureMailThreadClient(fixture)
  render(
    <MailThreadTab
      projectId={PROJECT_ID}
      documentId={THREAD_DOCUMENT_ID}
      threadId={fixture.view.id}
      folderId={THREAD_FOLDER_ID}
      viewerUserId={options.viewer === undefined ? VIEWER_ID : options.viewer}
      focus={options.focus}
      client={client}
    />,
  )
  return { client, fixture }
}

const entries = () => screen.findAllByTestId('mail-thread-entry')

beforeEach(() => {
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
})

describe('MailThreadTab', () => {
  it('lists the mails newest first, each with the Fassung it first appeared in', async () => {
    renderTab('three-messages')
    const rows = await entries()
    expect(rows.map((row) => within(row).getByTestId('mail-thread-entry-from').textContent)).toEqual(['from revision 3', 'from revision 2', 'from revision 1'])
    expect(within(rows[0]).getByTestId('mail-thread-entry-heading')).toHaveTextContent('14.10.2026, 09:12 · Mag. Huber (ma37.wien.gv.at)')
    expect(within(rows[0]).getByTestId('mail-thread-entry-trust')).toHaveTextContent('Domain verified: ma37.wien.gv.at')
    expect(within(rows[0]).getByTestId('mail-thread-entry-via')).toHaveTextContent('Filed on Piloti’s suggestion')
    expect(screen.getByTestId('mail-thread-waiting')).toHaveTextContent('2 mails of this mail thread wait in Project mail')
  })

  it('lists what came with a mail: links, already there, not filed with why, and a hidden one unnamed', async () => {
    renderTab('three-messages')
    const statik = (await entries())[1]
    const items = within(statik).getAllByTestId('mail-thread-attachment')
    expect(items.map((item) => item.dataset.disposition)).toEqual(['filed', 'already_present', 'not_filed', 'hidden'])
    expect(within(items[0]).getByRole('link', { name: 'S-101_C.pdf' })).toHaveAttribute('href', expect.stringMatching(/\/files\?doc=/))
    expect(items[1]).toHaveTextContent('was already in the project')
    expect(items[2]).toHaveTextContent('Rechnung_Okt.zip')
    expect(items[2]).toHaveTextContent('not filed · archive file, not unpacked')
    expect(within(items[2]).queryByRole('link')).toBeNull()
    expect(items[3]).toHaveTextContent('An attachment in a folder you cannot see')
  })

  it('says an unconfirmed sender with the warning glyph, in ink', async () => {
    renderTab('unverified-section')
    const trust = within((await entries())[0]).getByTestId('mail-thread-entry-trust')
    expect(trust).toHaveTextContent('Domain not verified')
    expect(trust.dataset.trust).toBe('unverified')
    expect(trust.className).toContain('text-foreground')
  })

  describe('the original', () => {
    it('downloads a clean one', async () => {
      const { client } = renderTab('three-messages')
      const download = vi.spyOn(client, 'downloadOriginal')
      await userEvent.click(within((await entries())[0]).getByTestId('mail-entry-original'))
      expect(download).toHaveBeenCalledWith(PROJECT_ID, MAIL_THREAD_VARIANTS['three-messages'].view.id, expect.any(String))
      expect(within((await entries())[0]).getByTestId('mail-entry-original').dataset.state).toBe('available')
    })

    it('says not clean when the scan on the download answers 409, in place of the button', async () => {
      renderTab('original-refused')
      const first = (await entries())[0]
      await userEvent.click(within(first).getByTestId('mail-entry-original'))
      await waitFor(() => expect(within(first).getByTestId('mail-entry-original').dataset.state).toBe('not_clean'))
      expect(first).toHaveTextContent('The original contains malware and cannot be downloaded')
      expect(within(first).queryByRole('button', { name: /Original/ })).toBeNull()
    })

    it('offers nothing for an infected one, and says „gone“ for an archive entry', async () => {
      renderTab('original-infected')
      expect(within((await entries())[0]).getByTestId('mail-entry-original').dataset.state).toBe('not_clean')
    })

    it('says an archive entry has no original', async () => {
      renderTab('archive-sections')
      const first = (await entries())[0]
      expect(within(first).getByTestId('mail-entry-original').dataset.state).toBe('gone')
      expect(first).toHaveTextContent('No original: taken over from the mail archive')
      expect(within(first).getByTestId('mail-thread-entry-trust')).toHaveTextContent('From the mail archive · not checked')
    })
  })

  describe('following', () => {
    it('follows, and the toast offers the undo', async () => {
      const { client } = renderTab('three-messages')
      const follow = vi.spyOn(client, 'follow')
      await userEvent.click(await screen.findByTestId('mail-thread-follow-start'))
      expect(follow).toHaveBeenCalledWith(PROJECT_ID, MAIL_THREAD_VARIANTS['three-messages'].view.id)
      await waitFor(() => expect(screen.getByTestId('mail-thread-follow-state')).toHaveTextContent(/^You follow this mail thread until /))
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^You follow “Stellplatznachweis” until /), expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }))
    })

    it('renews and stops a running follow', async () => {
      const { client } = renderTab('followed')
      const follow = vi.spyOn(client, 'follow')
      const unfollow = vi.spyOn(client, 'unfollow')
      await userEvent.click(await screen.findByTestId('mail-thread-follow-renew'))
      expect(follow).toHaveBeenCalledTimes(1)
      await userEvent.click(screen.getByTestId('mail-thread-follow-stop'))
      expect(unfollow).toHaveBeenCalledWith(PROJECT_ID, MAIL_THREAD_VARIANTS.followed.view.id)
      await waitFor(() => expect(screen.getByTestId('mail-thread-follow-start')).toBeInTheDocument())
    })

    it('offers no renewal when 180 days from the start are nearly reached, and says why', async () => {
      renderTab('renew-limit')
      expect(await screen.findByTestId('mail-thread-follow-limit')).toHaveTextContent('A follow lasts at most 180 days')
      expect(screen.queryByTestId('mail-thread-follow-renew')).toBeNull()
      expect(screen.getByTestId('mail-thread-follow-stop')).toBeInTheDocument()
    })

    it('lets a manager end someone else’s follow, by name', async () => {
      const { client } = renderTab('manager-follows')
      const unfollow = vi.spyOn(client, 'unfollow')
      const followers = await screen.findAllByTestId('mail-thread-follower')
      expect(followers).toHaveLength(2)
      await waitFor(() => expect(followers[0]).toHaveTextContent('Lukas Brandstätter'))
      await userEvent.click(within(followers[0]).getByRole('button', { name: 'End the follow of Lukas Brandstätter' }))
      expect(unfollow).toHaveBeenCalledWith(PROJECT_ID, MAIL_THREAD_VARIANTS['manager-follows'].view.id, { userId: 'user_01JLUKAS000000000000000000' })
      await waitFor(() => expect(screen.getAllByTestId('mail-thread-follower')).toHaveLength(1))
    })

    it('shows nobody else „End“: a member reads a count, and may not follow without filing rights', async () => {
      renderTab('member-sees-follows')
      expect(await screen.findByTestId('mail-thread-follow-others')).toHaveTextContent('2 other people follow')
      expect(screen.queryByTestId('mail-thread-followers')).toBeNull()
      expect(screen.queryByTestId('mail-thread-follower-end')).toBeNull()
      expect(screen.queryByTestId('mail-thread-follow-start')).toBeNull()
    })

    it('words a refusal, never the server’s English', async () => {
      const client = fixtureMailThreadClient(MAIL_THREAD_VARIANTS['three-messages'])
      const { ApiRequestError } = await import('@/adapters/api/api-error')
      vi.spyOn(client, 'follow').mockRejectedValue(new ApiRequestError('Project is closed', 403, 'project-closed'))
      renderTab('three-messages', { client })
      await userEvent.click(await screen.findByTestId('mail-thread-follow-start'))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The project is closed. Reopen it first.'))
    })
  })

  it('compares the mail’s Fassung with the one before', async () => {
    const { client } = renderTab('three-messages')
    const diff = vi.spyOn(client, 'diff')
    const newest = (await entries())[0]
    await userEvent.click(await within(newest).findByRole('button', { name: 'Compare revision 2 with revision 3' }))
    expect(diff).toHaveBeenCalledWith(THREAD_DOCUMENT_ID, expect.any(String), expect.any(String))
    expect(await within(newest).findByTestId('mail-thread-entry-comparison')).toBeInTheDocument()
    // The first mail started the thread: there is nothing before it.
    expect(within((await entries())[2]).queryByTestId('mail-thread-entry-compare')).toBeNull()
  })

  describe('detaching', () => {
    it('names the Fassungen that keep the mail, and moves it into the chosen thread', async () => {
      const { client } = renderTab('detach-confirm')
      const detach = vi.spyOn(client, 'detach')
      const statik = (await entries())[1]
      await userEvent.click(within(statik).getByTestId('mail-entry-menu'))
      await userEvent.click(await screen.findByTestId('mail-entry-detach'))
      const dialog = await screen.findByTestId('mail-thread-detach')
      expect(within(dialog).getByTestId('mail-thread-detach-keeps')).toHaveTextContent('Revisions 2 to 3 keep this mail. This mail thread gets revision 4 without it.')
      expect(dialog).toHaveTextContent('Whoever follows this mail thread stops following it.')
      const confirm = screen.getByTestId('mail-thread-detach-confirm')
      expect(confirm).toBeDisabled()
      await userEvent.click(within(dialog).getByTestId('mail-thread-detach-target'))
      await userEvent.click(await screen.findByRole('option', { name: 'Fassadenmuster Hofseite' }))
      await userEvent.click(confirm)
      await waitFor(() => expect(detach).toHaveBeenCalledTimes(1))
      expect(detach.mock.calls[0][3]).toEqual({ target: { action: 'append', mailThreadId: expect.any(String) } })
      await waitFor(() => expect(screen.getAllByTestId('mail-thread-entry')).toHaveLength(2))
      expect(toast.success).toHaveBeenCalledWith('Mail moved into “Fassadenmuster Hofseite”', expect.objectContaining({ description: '1 follow ended' }))
    })

    it('says a refusal inside the dialog, which stays open', async () => {
      renderTab('detach-refused')
      const statik = (await entries())[1]
      await userEvent.click(within(statik).getByTestId('mail-entry-menu'))
      await userEvent.click(await screen.findByTestId('mail-entry-detach'))
      const dialog = await screen.findByTestId('mail-thread-detach')
      await userEvent.click(within(dialog).getByLabelText('As a new mail thread'))
      await userEvent.type(within(dialog).getByTestId('mail-thread-detach-name'), 'Stellplätze Hof')
      await userEvent.click(screen.getByTestId('mail-thread-detach-confirm'))
      expect(await within(dialog).findByTestId('mail-thread-detach-refusal')).toHaveTextContent('A document of this name is already in the project.')
      expect(screen.getByTestId('mail-thread-detach')).toBeInTheDocument()
    })

    it('is not offered to a reader who may not file mail', async () => {
      renderTab('member-sees-follows')
      expect((await entries()).every((row) => within(row).queryByTestId('mail-entry-menu') === null)).toBe(true)
    })
  })

  it('scrolls a linked entry into view and marks it', async () => {
    const fixture = MAIL_THREAD_VARIANTS.focused
    renderTab('focused', { focus: { entryId: fixture.focusEntryId } })
    const rows = await entries()
    const focused = rows.find((row) => row.dataset.focused)
    expect(focused?.dataset.entryId).toBe(fixture.focusEntryId)
    expect(focused).toHaveAttribute('aria-current', 'location')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(focused))
  })

  it('says a failed read and reads again', async () => {
    const client = fixtureMailThreadClient(MAIL_THREAD_VARIANTS.error)
    const get = vi.spyOn(client, 'get')
    renderTab('error', { client })
    expect(await screen.findByText('The mails of this mail thread could not be loaded.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(get).toHaveBeenCalledTimes(2)
  })
})
