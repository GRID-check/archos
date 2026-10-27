/**
 * One held mail, decided: the bar says what will happen and sends exactly
 * that; a sender who needs confirming is confirmed first; a colleague who
 * decided first wins and the detail says so; the text is never markup; the
 * content check's choice reaches the request; dismissing offers the undo; a
 * filed text offers the follow, only where it could ever hold.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/app/projects/p/files/mail',
  useSearchParams: () => new URLSearchParams(),
}))

import { toast } from 'sonner'
import { render, screen, waitFor, within } from '@/test-utils'
import { ApiRequestError } from '@/adapters/api/api-error'
import { DETAIL_VARIANTS, FIXTURE_NOW, FOLDERS, PROJECT_ID, fixtureClient, mail, messagePart, text } from '@/app/dev/inbound-mail/fixtures'
import type { InboundMailClient } from '../lib/client'
import { InboundMailDetail } from './inbound-mail-detail'

function renderDetail(name: string, client: InboundMailClient = fixtureClient({ detail: DETAIL_VARIANTS[name] }), onChanged = vi.fn()) {
  const fixture = DETAIL_VARIANTS[name]
  render(
    <InboundMailDetail
      projectId={PROJECT_ID}
      mailId={fixture.view.id}
      initial={fixture.view}
      initialText={fixture.text}
      folders={FOLDERS}
      client={client}
      onChanged={onChanged}
      now={FIXTURE_NOW}
      pollMs={1}
      decidedByOther={fixture.decidedByOther}
    />
  )
  return { client, onChanged }
}

beforeEach(() => vi.clearAllMocks())

describe('InboundMailDetail', () => {
  it('says what the press will file, and files exactly that', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS['member-verified'] })
    const file = vi.spyOn(client, 'file')
    const { onChanged } = renderDetail('member-verified', client)
    const button = screen.getByTestId('decision-file')
    expect(button).toHaveTextContent('File 1 file and the mail text')
    await userEvent.click(button)
    await waitFor(() => expect(file).toHaveBeenCalledTimes(1))
    const body = file.mock.calls[0][1]
    expect(body.mails).toHaveLength(1)
    expect(body.mails[0]).toMatchObject({
      mailId: DETAIL_VARIANTS['member-verified'].view.id,
      message: { text: 'full', thread: { action: 'append' } },
      parts: [{ folderId: FOLDERS[1].id, newFolderPath: null, documentType: 'Bescheid' }],
    })
    expect(body.mails[0]).not.toHaveProperty('acknowledgeSender')
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    // One toast that says where each part went and which Fassung it became.
    expect(toast.success).toHaveBeenCalledTimes(1)
    const [title, options] = vi.mocked(toast.success).mock.calls[0] ?? []
    expect(title).toBe('Filed 1 file and the mail text')
    expect(options?.action).toMatchObject({ label: 'View' })
    const description = options?.description
    render(<>{typeof description === 'function' ? description() : description}</>)
    const lines = screen.getAllByTestId('filed-lines').at(-1) as HTMLElement
    expect(within(lines).getAllByRole('listitem').map((line) => line.textContent)).toEqual([
      'Mail text → “Stellplatznachweis” · revision 4',
      'Bescheid_MA37_2026-10-14.pdf → Behörde/Bescheide · revision 1',
    ])
  })

  it('says where each filed part went and which Fassung it became, with the way to it', async () => {
    renderDetail('filed-outcome')
    expect(screen.getByTestId('message-filed')).toHaveTextContent('Filed in mail thread “Stellplatznachweis” · revision 7 · Open')
    expect(screen.getByTestId('status-filed')).toHaveTextContent('Filed in Behörde/Bescheide · revision 1 · Open')
    // One part was dismissed, not the mail: the banner counts the part.
    expect(screen.getByTestId('detail-restorable')).toHaveTextContent('1 part dismissed · can be restored until')
    expect(screen.getByTestId('detail-restorable')).not.toHaveTextContent(/^Dismissed/)
  })

  it('says a part was filed, never where, when the viewer may not see its folder', () => {
    const fixture = DETAIL_VARIANTS['filed-outcome']
    const hidden = { ...fixture.view, parts: fixture.view.parts.map((part) => ({ ...part, filedAs: null, documentId: null })) }
    render(
      <InboundMailDetail projectId={PROJECT_ID} mailId={hidden.id} initial={hidden} initialText={fixture.text} folders={FOLDERS} client={fixtureClient({ detail: { ...fixture, view: hidden } })} onChanged={vi.fn()} now={FIXTURE_NOW} />
    )
    expect(screen.getByTestId('status-filed')).toHaveTextContent('Filed in Files')
    expect(screen.getByTestId('status-filed')).not.toHaveTextContent('Behörde')
  })

  it('names the thread and its revision when only the text goes', () => {
    renderDetail('thread-append')
    expect(screen.getByTestId('decision-file')).toHaveTextContent('File in mail thread “Stellplatznachweis” (becomes revision 4)')
  })

  it('offers nothing of an impersonation checked, asks for the unverified domain before filing, and sends the yes', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS.impersonation })
    const file = vi.spyOn(client, 'file')
    renderDetail('impersonation', client)
    expect(screen.getByTestId('sender-trust')).toHaveTextContent('Poses as Miriam Huber')
    // „Dringend: Kontoänderung Honorarnote“: filing is folded away; opening it is the first deliberate press.
    await userEvent.click(screen.getByTestId('impersonation-file-anyway'))
    expect(screen.getByTestId('message-checkbox')).not.toBeChecked()
    expect(screen.getByTestId('attachment-checkbox')).not.toBeChecked()
    await userEvent.click(screen.getByTestId('message-checkbox'))
    const button = screen.getByTestId('decision-file')
    expect(button).toBeDisabled()
    await userEvent.click(screen.getByTestId('acknowledge-sender'))
    expect(button).toBeEnabled()
    await userEvent.click(button)
    await waitFor(() => expect(file).toHaveBeenCalled())
    expect(file.mock.calls[0][1].mails[0].acknowledgeSender).toBe(true)
  })

  it('warns above everything of a mail posing as a member, and its yes says the person checked it', async () => {
    renderDetail('impersonation')
    const warning = screen.getByTestId('impersonation-warning')
    expect(warning).toHaveTextContent('Careful: this mail poses as Miriam Huber. Its signature is invalid or was rejected by the domain.')
    expect(warning).toHaveTextContent('Piloti suggests nothing and nothing is preselected. Check payment or bank detail changes by phone, never by replying.')
    // Above the header, before anything can be checked.
    expect(warning.compareDocumentPosition(screen.getByTestId('mail-header')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await userEvent.click(screen.getByTestId('impersonation-file-anyway'))
    await userEvent.click(screen.getByTestId('message-checkbox'))
    expect(screen.getByTestId('acknowledge-sender').closest('div')).toHaveTextContent('I checked that the mail is genuine. File it anyway')
  })

  it('makes an impersonation a stop: „Verwerfen“ is the primary press, filing is folded behind „File anyway …“', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS.impersonation })
    const dismiss = vi.spyOn(client, 'dismiss')
    renderDetail('impersonation', client)
    expect(screen.queryByTestId('message-checkbox')).toBeNull()
    expect(screen.queryByTestId('attachment-checkbox')).toBeNull()
    expect(screen.queryByTestId('decision-file')).toBeNull()
    expect(screen.queryByTestId('acknowledge-sender')).toBeNull()
    const discard = screen.getByTestId('decision-dismiss')
    expect(discard.className).toContain('order-last')
    expect(discard.className).toContain('bg-primary')
    const open = screen.getByTestId('impersonation-file-anyway')
    expect(open).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(open)
    expect(open).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('message-checkbox')).toBeInTheDocument()
    expect(screen.getByTestId('decision-file')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('message-checkbox'))
    // Opened, filing still needs the yes.
    expect(screen.getByTestId('decision-file')).toBeDisabled()
    expect(screen.getByTestId('acknowledge-sender')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('decision-dismiss'))
    await waitFor(() => expect(dismiss).toHaveBeenCalled())
  })

  it('folds nothing for a mail that poses as nobody', () => {
    renderDetail('external-unverified')
    expect(screen.queryByTestId('impersonation-file-anyway')).toBeNull()
    expect(screen.getByTestId('decision-file')).toBeInTheDocument()
  })

  it('wears Piloti’s mark only on a folder Piloti suggested, never on the rule’s correspondence folder', () => {
    renderDetail('external-unverified')
    // A new thread for an unconfirmed stranger goes to the correspondence folder by rule: a plain folder chip.
    const chip = screen.getByTestId('detail-new-thread-folder')
    expect(chip.querySelector('[data-testid="filing-chip-folder"]')).not.toBeNull()
    expect(chip).not.toHaveAttribute('data-suggested')
  })

  it('names the member and the address that is not theirs', () => {
    renderDetail('member-name')
    expect(screen.getByTestId('impersonation-warning')).toHaveTextContent('Careful: the name Miriam Huber belongs to a member, the address miriam.huber@mail.example does not.')
    expect(screen.getByTestId('impersonation-warning').dataset.basis).toBe('member_name')
  })

  it('pre-selects nothing and shows no suggestion of an impersonation, even when a stale view offers them', async () => {
    const suggested = DETAIL_VARIANTS['member-verified'].view.parts.find((part) => part.kind === 'attachment' && part.suggestion)?.suggestion ?? null
    expect(suggested).not.toBeNull()
    const base = DETAIL_VARIANTS.impersonation
    const stale = { ...base.view, parts: base.view.parts.map((part) => ({ ...part, preselected: true, suggestion: part.kind === 'attachment' ? suggested : null })) }
    const client = fixtureClient({ detail: { ...base, view: stale } })
    render(
      <InboundMailDetail projectId={PROJECT_ID} mailId={stale.id} initial={stale} initialText={base.text} folders={FOLDERS} client={client} onChanged={vi.fn()} now={FIXTURE_NOW} pollMs={1} />
    )
    await userEvent.click(screen.getByTestId('impersonation-file-anyway'))
    expect(screen.getByTestId('message-checkbox')).not.toBeChecked()
    expect(screen.getByTestId('attachment-checkbox')).not.toBeChecked()
    await userEvent.click(screen.getByTestId('attachment-checkbox'))
    expect(screen.queryByText('Piloti’s suggestion')).toBeNull()
    expect(screen.queryByTestId('attachment-folder')).toBeNull()
  })

  it('says why the mail text cannot be filed while the mail’s own malware check is not clean', () => {
    renderDetail('original-infected')
    expect(screen.getByTestId('message-checkbox')).toBeDisabled()
    expect(screen.getByTestId('message-scan-infected')).toHaveTextContent('The mail contains malware, so its text cannot be filed.')

    const base = DETAIL_VARIANTS['member-verified']
    const failed = { ...base.view, rawScan: 'failed' as const }
    render(
      <InboundMailDetail projectId={PROJECT_ID} mailId={failed.id} initial={failed} initialText={base.text} folders={FOLDERS} client={fixtureClient({ detail: { ...base, view: failed } })} onChanged={vi.fn()} now={FIXTURE_NOW} pollMs={1} />
    )
    expect(screen.getByTestId('message-scan-failed')).toHaveTextContent('The mail’s malware check failed and is being repeated. Its text can be filed once the check passes.')
  })

  it('gives no scan reason beside a text whose mail scanned clean', () => {
    renderDetail('member-verified')
    expect(screen.getByTestId('message-checkbox')).toBeEnabled()
    expect(screen.queryByTestId(/^message-scan-/)).toBeNull()
  })

  it('warns of nothing for a mail that poses as nobody', () => {
    renderDetail('external-unverified')
    expect(screen.queryByTestId('impersonation-warning')).toBeNull()
  })

  it('names the term the name check stopped a new thread’s name for, and offers the release', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS['new-thread'] })
    vi.spyOn(client, 'file').mockRejectedValue(new ApiRequestError('stopped', 409, 'name_stop', { reason: 'name_stop', terms: ['Honorar'] }))
    renderDetail('new-thread', client)
    await userEvent.click(screen.getByTestId('decision-file'))
    expect(await screen.findByTestId('thread-name-stop')).toHaveTextContent('Name check: “Honorar”')
    expect(screen.getByTestId('thread-release-name')).toBeInTheDocument()
  })

  it('reads the mail again when a colleague decided first, and says so', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS['member-verified'] })
    vi.spyOn(client, 'file').mockRejectedValue(new ApiRequestError('stale', 409, 'stale'))
    const handled = mail({ key: 'member-verified', status: 'handled', parts: [messagePart({ id: 'x', state: 'filed' })] })
    vi.spyOn(client, 'get').mockResolvedValue({ ...handled, id: DETAIL_VARIANTS['member-verified'].view.id })
    renderDetail('member-verified', client)
    await userEvent.click(screen.getByTestId('decision-file'))
    expect(await screen.findByTestId('detail-decided-by-other')).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('changed in the meantime'))
    expect(screen.queryByTestId('decision-bar')).not.toBeInTheDocument()
  })

  it('prints a stranger’s markup as text, and a link as inert text', () => {
    const fixture = DETAIL_VARIANTS['member-verified']
    render(
      <InboundMailDetail
        projectId={PROJECT_ID}
        mailId={fixture.view.id}
        initial={fixture.view}
        initialText={text({ ownText: '<img src=x onerror="alert(1)"> https://evil.example/x', quoted: [] })}
        folders={FOLDERS}
        client={fixtureClient({ detail: fixture })}
        onChanged={vi.fn()}
      />
    )
    const own = screen.getByTestId('mail-text-own')
    expect(own.querySelector('img')).toBeNull()
    expect(own.querySelector('a')).toBeNull()
    expect(own).toHaveTextContent('<img src=x onerror="alert(1)">')
  })

  it('files a text with findings masked by default, whole when chosen', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS['content-finding'] })
    const file = vi.spyOn(client, 'file')
    renderDetail('content-finding', client)
    expect(screen.getByTestId('content-finding-choice')).toHaveTextContent('IBAN')
    await userEvent.click(screen.getByTestId('finding-full'))
    await userEvent.click(screen.getByTestId('decision-file'))
    await waitFor(() => expect(file).toHaveBeenCalled())
    expect(file.mock.calls[0][1].mails[0].message?.text).toBe('full')
  })

  it('dismisses with an undo that restores', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS['member-verified'] })
    const restore = vi.spyOn(client, 'restore')
    renderDetail('member-verified', client)
    await userEvent.click(screen.getByTestId('decision-dismiss'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Mail dismissed', expect.objectContaining({ action: expect.any(Object) })))
    const action = vi.mocked(toast.success).mock.calls.at(-1)?.[1]?.action
    if (!action || typeof action !== 'object' || !('onClick' in action)) throw new Error('the dismissal offered no undo')
    action.onClick({} as never)
    await waitFor(() => expect(restore).toHaveBeenCalled())
    expect(await screen.findByTestId('decision-bar')).toBeInTheDocument()
  })

  it('offers the follow after the text was filed, for a sender who could qualify', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS['follow-offer'] })
    const follow = vi.spyOn(client, 'follow')
    renderDetail('follow-offer', client)
    await userEvent.click(await screen.findByTestId('follow-offer-button'))
    await waitFor(() => expect(follow).toHaveBeenCalledWith(PROJECT_ID, expect.any(String)))
    expect(await screen.findByText('You follow “Stellplatznachweis”')).toBeInTheDocument()
  })

  it('offers no follow where a reply could never qualify', async () => {
    const fixture = DETAIL_VARIANTS['follow-offer']
    const view = { ...fixture.view, sender: { ...fixture.view.sender!, trust: 'external_unverified' as const, reason: 'dkim_none' as const } }
    const client = fixtureClient({ detail: { ...fixture, view } })
    const lookup = vi.spyOn(client, 'threadOfDocument')
    render(<InboundMailDetail projectId={PROJECT_ID} mailId={view.id} initial={view} initialText={fixture.text} folders={FOLDERS} client={client} onChanged={vi.fn()} />)
    await screen.findByTestId('message-filed')
    expect(lookup).not.toHaveBeenCalled()
    expect(screen.queryByTestId('follow-offer')).not.toBeInTheDocument()
  })

  it('states every attachment case of the mixed mail', () => {
    renderDetail('mixed-attachments')
    expect(screen.getByTestId('note-revision')).toHaveTextContent('becomes revision 3 of S-101_B.pdf')
    expect(screen.getByTestId('note-duplicate')).toHaveTextContent('Already in the project: Behörde/Bescheide/Bescheid_alt.pdf')
    expect(screen.getByTestId('note-encrypted')).toBeInTheDocument()
    expect(screen.getByTestId('note-image')).toBeInTheDocument()
    expect(screen.getByTestId('not-staged')).toHaveTextContent('winmail.dat · Outlook’s own attachment')
    expect(screen.getByTestId('not-staged')).toHaveTextContent('2 pictures from the signature')
  })

  it('offers no checkbox it could not honour', () => {
    renderDetail('scan-pending')
    for (const row of screen.getAllByTestId(/^attachment-/).filter((element) => element.tagName === 'LI')) {
      expect(within(row).getByTestId('attachment-checkbox')).toBeDisabled()
    }
    expect(screen.getByTestId('status-scan-pending')).toBeInTheDocument()
    expect(screen.getByTestId('status-scan-failed')).toBeInTheDocument()
  })

  it('needs „File anyway“ before a stopped name is filed', async () => {
    renderDetail('name-stop')
    await userEvent.click(screen.getByTestId('attachment-checkbox'))
    expect(screen.getByTestId('decision-file')).toBeDisabled()
    expect(screen.getByTestId('decision-blocker')).toHaveTextContent('Confirm the name check for 1 attachment.')
    await userEvent.click(screen.getByTestId('attachment-release-name'))
    expect(screen.getByTestId('decision-file')).toBeEnabled()
  })

  it('says a partial failure and a full storage from the mail itself', () => {
    renderDetail('partial-failure')
    expect(screen.getByTestId('detail-partial-failure')).toHaveTextContent('1 of 2 files could not be filed.')
    expect(screen.getByTestId('note-last-failure')).toHaveTextContent('the name is already taken')
  })

  it('says the project is closed and files nothing there', () => {
    renderDetail('closed')
    expect(screen.getByTestId('detail-closed')).toBeInTheDocument()
    expect(screen.getByTestId('decision-file')).toHaveTextContent('File nothing')
  })

  it('offers the restore of an expired mail', async () => {
    const client = fixtureClient({ detail: DETAIL_VARIANTS.expired })
    const restore = vi.spyOn(client, 'restore')
    renderDetail('expired', client)
    await userEvent.click(screen.getByTestId('detail-restore'))
    await waitFor(() => expect(restore).toHaveBeenCalled())
  })

  it('shows its skeleton, then its error with a retry', async () => {
    renderDetail('error', fixtureClient({ detail: DETAIL_VARIANTS.error }))
    expect(screen.getByTestId('inbound-mail-detail')).toBeInTheDocument()
    const fixture = DETAIL_VARIANTS.error
    const client = fixtureClient({ detail: fixture })
    render(<InboundMailDetail projectId={PROJECT_ID} mailId={fixture.view.id} initial={null} folders={FOLDERS} client={client} onChanged={vi.fn()} />)
    expect(await screen.findByText('This mail could not be loaded.')).toBeInTheDocument()
  })
})
