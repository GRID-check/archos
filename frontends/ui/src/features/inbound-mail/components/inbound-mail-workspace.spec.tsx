/**
 * Dateien › E-Mail-Eingang: the list beside the open mail, its states, the
 * keyboard (J/K walk, X selects, Enter opens, ⌫ asks to dismiss the
 * selection), „Bereit“ and „Braucht Sie“, and filing as suggested, by one
 * row's press, the „Bereit“ heading, a thread group or a selection: one rule
 * for all of them, only for complete mails, never for an impersonation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/app/projects/p/files/mail',
  useSearchParams: () => new URLSearchParams(),
}))

import { toast } from 'sonner'
import { capturePosthog } from '@/lib/analytics/posthog'
import { act, fireEvent, render, screen, waitFor, within } from '@/test-utils'
import {
  ADDRESS_VARIANTS,
  DETAIL_VARIANTS,
  FIXTURE_NOW,
  FOLDERS,
  LIST_VARIANTS,
  PROJECT_ID,
  PROJECT_NAME,
  fixtureAddressClient,
  fixtureClient,
  listPage,
} from '@/app/dev/inbound-mail/fixtures'
import { resetInboundMailWaitingForTests } from '../hooks/use-inbound-mail-waiting'
import { InboundMailWorkspace } from './inbound-mail-workspace'

function renderWorkspace(variant: string, overrides: Partial<Parameters<typeof InboundMailWorkspace>[0]> = {}) {
  const fixture = LIST_VARIANTS[variant]
  const client = fixtureClient({ list: fixture })
  const status = fixture.status ?? 'waiting'
  render(
    <InboundMailWorkspace
      projectId={PROJECT_ID}
      projectName={PROJECT_NAME}
      projectClosed={fixture.closed ?? false}
      folders={FOLDERS}
      status={status}
      outcome={fixture.outcome ?? null}
      initialList={fixture.load ? null : listPage(fixture.items.filter((item) => item.status === status), fixture.nextCursor ?? null)}
      initialListFailed={fixture.load === 'error'}
      mailId={null}
      initialMail={null}
      client={client}
      addressClient={fixtureAddressClient(
        fixture.everReceived === false ? { ...(ADDRESS_VARIANTS.manager as Exclude<(typeof ADDRESS_VARIANTS)['manager'], string>), lastReceivedAt: null } : ADDRESS_VARIANTS.manager
      )}
      now={FIXTURE_NOW}
      initialChecked={fixture.checked}
      {...overrides}
    />
  )
  return { client }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetInboundMailWaitingForTests()
})

describe('InboundMailWorkspace', () => {
  it('groups a conversation with one button that files it as suggested', async () => {
    renderWorkspace('selected')
    const group = screen.getByRole('region', { name: /Mail thread “Stellplatznachweis” · 4 new mails/ })
    expect(within(group).getByTestId('thread-group-file')).toHaveTextContent('File all 4 (becomes revisions 4–7)')
    await userEvent.click(within(group).getByTestId('thread-group-file'))
    const destinations = await screen.findByTestId('bulk-destinations')
    expect(destinations).toHaveTextContent('In mail thread “Stellplatznachweis”: 4')
    expect(destinations).toHaveTextContent('In “Tragwerk”: 1')
  })

  it('splits a conversation: its ready replies go in one press, the ones that need a look are gone through in order', () => {
    renderWorkspace('thread-group')
    const ready = screen.getByRole('region', { name: /3 new mails/ })
    expect(within(ready).getByTestId('thread-group-file')).toHaveTextContent('File all 3 (becomes revisions 4–6)')
    const waiting = screen.getByRole('region', { name: /2 new mails/ })
    expect(within(waiting).queryByTestId('thread-group-file')).toBeNull()
    expect(within(waiting).getByTestId('thread-group-open')).toHaveAttribute('href', expect.stringContaining('/files/mail/'))
    expect(screen.getByTestId('readiness-ready').compareDocumentPosition(ready) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('readiness-needs_you').compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('opens the first mail of a group that changed since the list was read and no longer goes in one press', async () => {
    const { client } = renderWorkspace('selected')
    const get = client.get.bind(client)
    vi.spyOn(client, 'get').mockImplementation(async (projectId, mailId) => ({ ...(await get(projectId, mailId)), incompleteReason: 'scanning' }))
    const group = screen.getByRole('region', { name: /4 new mails/ })
    await userEvent.click(within(group).getByTestId('thread-group-file'))
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(expect.stringContaining('/files/mail/')))
    expect(screen.queryByTestId('bulk-destinations')).not.toBeInTheDocument()
  })

  it('heads the list with „Bereit“ and „Braucht Sie“, and says on each waiting row what it needs', () => {
    renderWorkspace('many')
    expect(screen.getByTestId('readiness-ready')).toHaveTextContent('Ready (3)')
    expect(screen.getByTestId('readiness-needs_you')).toHaveTextContent('Needs you (4)')
    const nameStop = screen.getByTestId(`inbound-mail-row-${DETAIL_VARIANTS['name-stop'].view.id}`)
    expect(within(nameStop).getByTestId('inbound-mail-row-reason')).toHaveTextContent('Check an attachment')
    // The server's first reason: the Statik the sender cannot vouch for as the next Fassung comes before the thread.
    const unvouched = screen.getByTestId(`inbound-mail-row-${DETAIL_VARIANTS['unverified-thread'].view.id}`)
    expect(within(unvouched).getByTestId('inbound-mail-row-reason')).toHaveAttribute('data-reason', 'needs_person')
    // The forged mail says its stop in red instead, and is never one press away.
    const forged = screen.getByTestId(`inbound-mail-row-${DETAIL_VARIANTS.impersonation.view.id}`)
    expect(within(forged).queryByTestId('inbound-mail-row-reason')).toBeNull()
    expect(within(forged).queryByTestId('inbound-mail-row-file')).toBeNull()
    expect(within(nameStop).queryByTestId('inbound-mail-row-file')).toBeNull()
  })

  it('files a ready row in one press: the same request as bulk, no confirmation, and says where everything goes', async () => {
    const { client } = renderWorkspace('many')
    const file = vi.spyOn(client, 'file')
    const id = DETAIL_VARIANTS['authority-statement'].view.id
    await userEvent.click(within(screen.getByTestId(`inbound-mail-row-${id}`)).getByTestId('inbound-mail-row-file'))
    await waitFor(() => expect(file).toHaveBeenCalledTimes(1))
    const body = file.mock.calls[0][1]
    expect(body.mails).toHaveLength(1)
    expect(body.mails[0]).toMatchObject({ mailId: id, message: { thread: { action: 'append' } }, parts: [{ name: 'Stellungnahme_MA37_Brandschutz.pdf' }] })
    expect(body.mails[0]).not.toHaveProperty('acknowledgeSender')
    expect(body.mails[0]).not.toHaveProperty('acknowledgeRisk')
    expect(screen.queryByTestId('bulk-destinations')).not.toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('1 mail is being filed as suggested', {
      description: 'In mail thread “Verfahren MA 37”: 1 · In “Behörde”: 1',
    })
    expect(capturePosthog).toHaveBeenCalledWith('inbound_mail_filed_as_suggested', { surface: 'row', mails: 1, files: 1, texts: 1 })
  })

  it('reads a ready row again before its press and files nothing that changed meanwhile', async () => {
    const { client } = renderWorkspace('many')
    const file = vi.spyOn(client, 'file')
    const get = client.get.bind(client)
    vi.spyOn(client, 'get').mockImplementation(async (projectId, mailId) => ({ ...(await get(projectId, mailId)), incompleteReason: 'scanning' }))
    const id = DETAIL_VARIANTS['authority-statement'].view.id
    await userEvent.click(within(screen.getByTestId(`inbound-mail-row-${id}`)).getByTestId('inbound-mail-row-file'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('1 mail is still being checked for malware.'))
    expect(file).not.toHaveBeenCalled()
  })

  it('files every ready mail from the „Bereit“ heading after the bulk confirmation', async () => {
    const { client } = renderWorkspace('many')
    const file = vi.spyOn(client, 'file')
    await userEvent.click(screen.getByTestId('readiness-file-all'))
    const destinations = await screen.findByTestId('bulk-destinations')
    expect(destinations).toHaveTextContent('In mail thread “Stellplatznachweis”: 2')
    expect(destinations).toHaveTextContent('In mail thread “Verfahren MA 37”: 1')
    await userEvent.click(screen.getByTestId('bulk-file-confirm'))
    await waitFor(() => expect(file).toHaveBeenCalledTimes(1))
    expect(file.mock.calls[0][1].mails).toHaveLength(3)
    expect(capturePosthog).toHaveBeenCalledWith('inbound_mail_filed_as_suggested', expect.objectContaining({ surface: 'ready_section', mails: 3 }))
  })

  it('keeps unconfirmed and automatic mail in a quiet group, listed when opened', async () => {
    renderWorkspace('unverified-group')
    const toggle = screen.getByTestId('quiet-group-toggle')
    expect(toggle).toHaveTextContent('Domain not verified or automatic (2)')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(within(screen.getByTestId('quiet-group')).getAllByTestId('inbound-mail-row-link')).toHaveLength(2)
  })

  it('teaches the address when nothing ever arrived, and says „all done“ otherwise', async () => {
    renderWorkspace('empty')
    expect(await screen.findByTestId('inbound-mail-never')).toHaveTextContent('No mail to this project yet')
    expect(await screen.findByTestId('inbound-mail-address')).toHaveTextContent('bauplatz-12.k3x7q2m9p4ab@piloti.at')
  })

  it('says „nothing waits“ for a project that had mail', async () => {
    renderWorkspace('done')
    expect(await screen.findByText('Nothing waits to be filed')).toBeInTheDocument()
  })

  it('says a failed list in its own words', () => {
    renderWorkspace('error')
    expect(screen.getByText('Project mail could not be loaded.')).toBeInTheDocument()
  })

  it('walks the rows with J and K, selects with X and opens with Enter', async () => {
    renderWorkspace('one')
    const id = DETAIL_VARIANTS['member-verified'].view.id
    fireEvent.keyDown(window, { key: 'j' })
    expect(await screen.findByTestId(`inbound-mail-row-${id}`)).toHaveAttribute('data-focused', 'true')
    fireEvent.keyDown(window, { key: 'x' })
    expect(within(screen.getByTestId(`inbound-mail-row-${id}`)).getByTestId('inbound-mail-row-checkbox')).toBeChecked()
    expect(await screen.findByTestId('inbound-mail-selection-bar')).toHaveTextContent('1 selected')
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(nav.push).toHaveBeenCalledWith(expect.stringContaining(`/files/mail/${id}`))
  })

  it('ignores the keys while the person types', () => {
    renderWorkspace('one')
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'j' })
    expect(screen.getByTestId(`inbound-mail-row-${DETAIL_VARIANTS['member-verified'].view.id}`)).not.toHaveAttribute('data-focused')
    input.remove()
  })

  it('offers „File as suggested“ only when every selected mail is complete, and says why not', async () => {
    renderWorkspace('bulk-blocked')
    const file = await screen.findByTestId('selection-file')
    await waitFor(() => expect(screen.getByTestId('selection-why')).toHaveAccessibleName(/needs its sender confirmed/))
    expect(file).toBeDisabled()
  })

  it('never offers an impersonation for bulk filing: no checkbox, a red label, and X does not select it', async () => {
    renderWorkspace('many')
    const row = await screen.findByTestId(`inbound-mail-row-${DETAIL_VARIANTS.impersonation.view.id}`)
    expect(within(row).queryByTestId('inbound-mail-row-checkbox')).toBeNull()
    expect(within(row).getByTestId('inbound-mail-row-impersonation')).toHaveTextContent('Poses as Miriam Huber · do not file')
    const other = screen.getByTestId(`inbound-mail-row-${DETAIL_VARIANTS['member-verified'].view.id}`)
    expect(within(other).getByTestId('inbound-mail-row-checkbox')).toBeInTheDocument()
    // Walk to it with J and press X: nothing is selected.
    for (let step = 0; step < 10 && row.dataset.focused !== 'true'; step += 1) {
      fireEvent.keyDown(window, { key: 'j' })
      await waitFor(() => expect(screen.getAllByTestId(/^inbound-mail-row-/).some((candidate) => candidate.dataset.focused === 'true')).toBe(true))
    }
    expect(screen.getByTestId(`inbound-mail-row-${DETAIL_VARIANTS.impersonation.view.id}`)).toHaveAttribute('data-focused', 'true')
    fireEvent.keyDown(window, { key: 'x' })
    expect(screen.queryByTestId('inbound-mail-selection-bar')).toBeNull()
  })

  it('files a complete selection after a confirmation grouped by destination', async () => {
    const { client } = renderWorkspace('selected')
    const file = vi.spyOn(client, 'file')
    await waitFor(() => expect(screen.getByTestId('selection-file')).toBeEnabled())
    await userEvent.click(screen.getByTestId('selection-file'))
    expect(await screen.findByTestId('bulk-destinations')).toHaveTextContent('In mail thread “Stellplatznachweis”: 2')
    await userEvent.click(screen.getByTestId('bulk-file-confirm'))
    await waitFor(() => expect(file).toHaveBeenCalled())
    const body = file.mock.calls[0][1]
    expect(body.mails).toHaveLength(2)
    for (const decision of body.mails) {
      expect(decision).not.toHaveProperty('acknowledgeSender')
      expect(decision).not.toHaveProperty('acknowledgeRisk')
    }
  })

  it('asks before dismissing a selection with ⌫', async () => {
    renderWorkspace('selected')
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Backspace' })
    })
    expect(await screen.findByText('Dismiss 2 mails?')).toBeInTheDocument()
  })

  it('switches to the handled list by replacing the URL', async () => {
    renderWorkspace('one')
    await userEvent.click(screen.getByTestId('filter-handled'))
    expect(nav.replace).toHaveBeenCalledWith(expect.stringContaining('status=handled'))
  })

  it('says a closed project above the rows', () => {
    renderWorkspace('closed')
    expect(screen.getByTestId('inbound-mail-closed')).toHaveTextContent('The project is closed – reopen it to file')
  })
})
