import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render as renderPlain } from '@testing-library/react'
import { act, fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { I18nProvider } from '@/i18n'

import type { InboxItemView } from '@/lib/inbox/types'
import { formatAbsoluteTime } from '@/lib/format'
import { DocumentLifecycleError } from '@/lib/documents/lifecycle-client'
import { AnnotationRequestError } from '@/lib/annotations/client'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { InboxItemRow, type InboxMarkClient } from './InboxItemRow'
import { ARCHIVE_UNDO_MS } from '../hooks/use-undoable-archive'

/** Where the row is drawn: the Postfach, as the reader has it filtered. */
const page = vi.hoisted(() => ({ pathname: '/', search: '' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => page.pathname,
  useSearchParams: () => new URLSearchParams(page.search),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const base: InboxItemView = {
  id: 'i1',
  type: 'mention.requested',
  state: 'unread',
  archived: false,
  actionable: true,
  resourceType: 'conversation',
  resourceId: 'c1',
  anchorId: 'm-9',
  actorName: 'Anna Weber',
  actorUserId: 'u-anna',
  count: 1,
  href: '/app/projects/p1/chat?session=c1#m-9',
  subject: 'Atrium – Rauchabschnitte',
  related: null,
  excerpt: 'Ist die Annahme richtig?',
  mentions: [],
  variant: null,
  answerIn: null,
  // Deliberately DIFFERENT moments: the row is timed by `updatedAt`, and while
  // the two matched here every assertion about which one the <time> carries was
  // true of both.
  createdAt: '2026-07-24T09:00:00Z',
  updatedAt: '2026-07-29T09:00:00Z',
}

const item = (overrides: Partial<InboxItemView> = {}): InboxItemView => ({ ...base, ...overrides })

/** Default locale in an unprovided test tree is `en`. */
describe('InboxItemRow — registry-driven rendering (IB-6)', () => {
  test('renders a mention request from its registry entry: who, what and where', () => {
    render(<InboxItemRow item={item()} />)
    expect(screen.getByText('Anna Weber asked for your input')).toBeInTheDocument()
    expect(screen.getByText('in Atrium – Rauchabschnitte')).toBeInTheDocument()
    expect(screen.getByText('Ist die Annahme richtig?')).toBeInTheDocument()
    // …and when: a rendered, machine-readable timestamp (the exact relative
    // wording depends on how long ago the fixture is, so assert the element).
    const time = document.querySelector('time')
    expect(time).toHaveAttribute('datetime', base.updatedAt)
    expect(time?.textContent?.trim()).not.toBe('')
  })

  test('times the row by when it last changed, not when it was created', () => {
    // The list is ORDERED by updatedAt, so a grouped row that just absorbed a
    // message sorts to the top — and used to arrive there saying "5 days ago".
    render(
      <InboxItemRow
        item={item({
          type: 'conversation.activity',
          count: 3,
          createdAt: '2026-07-24T09:00:00Z',
          updatedAt: '2026-07-29T09:00:00Z',
        })}
      />,
    )
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-07-29T09:00:00Z')
  })

  test('an upload with no place to name reads its own sentence, never a stand-in subject', () => {
    const upload = { type: 'upload.completed' as const, resourceType: 'upload_batch' as const, actorName: null, actorUserId: null, excerpt: null, href: '/app/uploads/b1' }
    const { unmount } = render(<InboxItemRow item={item({ ...upload, subject: 'Wohnbau Nord' })} />)
    expect(screen.getByText('Wohnbau Nord: open the summary to see what arrived.')).toBeInTheDocument()
    unmount()

    render(<InboxItemRow item={item({ ...upload, subject: null })} />)
    expect(screen.getByText('Open the summary to see what arrived.')).toBeInTheDocument()
    expect(screen.queryByText(/Untitled/)).not.toBeInTheDocument()
  })

  test('renders a neutral row for a type this build does not know', () => {
    // `type` is a text column and the presentation map is exhaustive only at
    // compile time: a row from a newer deploy used to throw and take the whole
    // inbox route down with it.
    render(<InboxItemRow item={item({ type: 'conversation.reaction' as never })} />)
    expect(screen.getByText('Something happened')).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toBeInTheDocument()
  })

  test('a modified click does not spend the row\'s read state', () => {
    // Cmd/middle-clicking rows into background tabs is the triage gesture; it
    // used to mark every one of them read and remove them under the cursor.
    const onOpen = vi.fn()
    render(<InboxItemRow item={item()} onOpen={onOpen} />)
    const link = screen.getByRole('link')
    fireEvent.click(link, { metaKey: true })
    fireEvent.click(link, { ctrlKey: true })
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(link)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test('links to the target at the exact spot', () => {
    render(<InboxItemRow item={item()} />)
    expect(screen.getByRole('link')).toHaveAttribute('href', base.href as string)
  })

  test('a shared-with-you item renders from the same component, no switch needed', () => {
    render(
      <InboxItemRow
        item={item({ type: 'conversation.shared_with_you', actionable: false, state: 'read' })}
      />,
    )
    expect(screen.getByText('Anna Weber shared a conversation with you')).toBeInTheDocument()
  })

  test('a grouped row uses the many-variant of the counted title, and says who wrote last', () => {
    render(<InboxItemRow item={item({ type: 'conversation.activity', actionable: false, count: 3 })} />)
    expect(screen.getByText('3 new messages in “Atrium – Rauchabschnitte”, latest from Anna Weber')).toBeInTheDocument()
  })

  test('a single occurrence of a counted type says who wrote, and where, in one line', () => {
    render(<InboxItemRow item={item({ type: 'conversation.activity', actionable: false, count: 1 })} />)
    expect(screen.getByText('Anna Weber wrote in “Atrium – Rauchabschnitte”')).toBeInTheDocument()
    // The chat is in the title now, so the old „in {subject}“ line is gone.
    expect(screen.queryByText('in Atrium – Rauchabschnitte')).not.toBeInTheDocument()
  })

  test('a chat row without an actor says what arrived without inventing a „Someone“', () => {
    render(<InboxItemRow item={item({ type: 'conversation.activity', actionable: false, count: 2, actorName: null, actorUserId: null })} />)
    expect(screen.getByText('2 new messages in “Atrium – Rauchabschnitte”')).toBeInTheDocument()
  })

  test('a redacted chat row names no chat in quotes', () => {
    render(<InboxItemRow item={item({ type: 'conversation.activity', actionable: false, count: 2, href: null, subject: null, excerpt: null })} />)
    expect(screen.getByText('Messages in a chat')).toBeInTheDocument()
  })

  test('a read group with a spent counter does not claim one new message', () => {
    // `count` is occurrences SINCE THE ROW WAS LAST READ, so 0 is the ordinary
    // state of a read row — not an impossible one. Picking the one-variant for it
    // made a group of twenty the user had just read say "1 new message" while it
    // sat there with nothing new in it at all. Three cases, not two.
    render(
      <InboxItemRow
        item={item({ type: 'conversation.activity', actionable: false, state: 'read', count: 0 })}
      />,
    )
    expect(screen.getByText('Messages in “Atrium – Rauchabschnitte”')).toBeInTheDocument()
    expect(screen.queryByText('1 new message')).not.toBeInTheDocument()
    // …and it must not claim novelty either: there is nothing new in this row.
    expect(screen.queryByText(/new/i)).not.toBeInTheDocument()
  })

  test('falls back to the placeholder copy for an unresolvable actor and an untitled target', () => {
    render(<InboxItemRow item={item({ actorName: null, subject: null })} />)
    expect(screen.getByText('Someone asked for your input')).toBeInTheDocument()
    expect(screen.getByText('in Untitled conversation')).toBeInTheDocument()
  })

  test('an answered request is labelled as resolved, and its title says whose question it was', () => {
    render(<InboxItemRow item={item({ state: 'resolved' })} />)
    expect(screen.getByText('Answered')).toBeInTheDocument()
    expect(screen.getByText('Anna Weber’s question has been answered')).toBeInTheDocument()
    expect(screen.queryByText('Anna Weber asked for your input')).not.toBeInTheDocument()
  })

  test('in German an answered request reads „Die Frage von …“, without a genitive that breaks on „Markus“', () => {
    renderPlain(
      <I18nProvider initialLocale="de" fixedLocale>
        <InboxItemRow item={item({ state: 'resolved', actorName: 'Markus Hofer' })} />
      </I18nProvider>,
    )
    expect(screen.getByText('Die Frage von Markus Hofer ist beantwortet')).toBeInTheDocument()
  })

  test('an answer from nobody in particular says the question was answered, not „Someone replied“', () => {
    render(<InboxItemRow item={item({ type: 'mention.answered', actionable: false, state: 'read', actorName: null, actorUserId: null })} />)
    expect(screen.getByText('Your question was answered')).toBeInTheDocument()
    expect(screen.queryByText('Someone replied')).not.toBeInTheDocument()
  })

  test('an unread row is visually distinct from a read one', () => {
    const { unmount } = render(<InboxItemRow item={item()} />)
    expect(screen.getByRole('link')).toHaveClass('font-semibold')
    unmount()

    render(<InboxItemRow item={item({ state: 'read' })} />)
    expect(screen.getByRole('link')).not.toHaveClass('font-semibold')
  })
})

/**
 * IB-13/IB-14: an item whose target the recipient can no longer reach is redacted,
 * and must never be a working-looking link. This is a security behaviour, not a
 * cosmetic one — hence its own block.
 */
describe('InboxItemRow — inert items are never links (IB-13)', () => {
  const inert = item({ state: 'inert', href: null, excerpt: null, subject: null })

  test('renders no anchor at all — not an empty one, and not "#"', () => {
    render(<InboxItemRow item={inert} />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(document.querySelector('a')).toBeNull()
  })

  test('renders no anchor even if the server contradicted itself and sent an href', () => {
    // Defence in depth: `state` alone decides, so a stale/incorrect href on an
    // inert row cannot become a clickable link.
    render(<InboxItemRow item={item({ state: 'inert', href: '/app/projects/p1/chat?session=c1' })} />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  test('explains itself instead of vanishing', () => {
    render(<InboxItemRow item={inert} />)
    expect(screen.getByText('No longer available')).toBeInTheDocument()
    // Said once as a badge and once as the body; the third line that repeated it is gone.
    expect(screen.queryByText('You no longer have access to this.')).not.toBeInTheDocument()
    // The title still renders, so the row is not a mystery blank.
    expect(screen.getByText('Anna Weber asked for your input')).toBeInTheDocument()
  })

  test('names a withheld subject "no longer available", not "untitled"', () => {
    // The server withholds `subject` — the conversation TITLE — for any row whose
    // target the recipient can no longer reach, exactly as it withholds the
    // snippet (IB-13). Calling that "Untitled conversation" would misstate WHY the
    // row is nameless: the thread has a name, this reader is no longer entitled to
    // it. `href: null` is the server's signal that the row is redacted.
    render(<InboxItemRow item={item({ href: null, subject: null, excerpt: null })} />)

    // A complete sentence rather than the templated "in {subject}": that template
    // needs a real title, and the placeholder inside it produced nonsense in the
    // primary product language ("… in Nicht mehr verfügbar").
    expect(
      screen.getByText('This is no longer available to you.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('in Untitled conversation')).not.toBeInTheDocument()
  })

  test('still says "untitled" for a REACHABLE thread that genuinely has no name', () => {
    // The two cases must not be conflated in the other direction either.
    render(<InboxItemRow item={item({ subject: null })} />)

    expect(screen.getByText('in Untitled conversation')).toBeInTheDocument()
  })
})

describe('InboxItemRow — actions', () => {
  test('archive is a labelled button OUTSIDE the row link (no nested interactives)', () => {
    const onArchive = vi.fn()
    render(<InboxItemRow item={item()} onArchive={onArchive} />)

    const button = screen.getByRole('button', { name: 'Archive' })
    expect(button.closest('a')).toBeNull()
    expect(screen.getByRole('link').querySelector('button')).toBeNull()

    fireEvent.click(button)
    expect(onArchive).toHaveBeenCalledWith('i1')
  })

  test('omits the archive control when no handler is supplied', () => {
    render(<InboxItemRow item={item()} />)
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
  })

  test('reports an opened row so the list can mark it read', () => {
    const onOpen = vi.fn()
    render(<InboxItemRow item={item()} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('link'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }))
  })
})

describe('InboxItemRow — the operational storage alert (ADR-0042)', () => {
  /** The row as `evaluateStorageAlert` produces it: system-generated, no actor. */
  const storageAlert = (overrides: Partial<InboxItemView> = {}): InboxItemView =>
    item({
      id: 'i-storage',
      type: 'storage.quota_warning',
      actionable: false,
      resourceType: 'organization',
      resourceId: 'org_1',
      anchorId: '80',
      actorName: null,
      actorUserId: null,
      href: '/app/organization/storage',
      // The locale-neutral token the emitter puts in `payload.subject`.
      subject: '82%',
      excerpt: null,
      ...overrides,
    })

  test('renders the warning copy and links to the page that explains it', () => {
    render(<InboxItemRow item={storageAlert()} />)

    expect(screen.getByText('Your organization is running out of storage')).toBeInTheDocument()
    expect(
      screen.getByText(
        '82% of the storage quota is in use. Once it is full, uploads will start failing — delete documents you no longer need, or ask whoever runs Piloti for you to raise the quota.',
      ),
    ).toBeInTheDocument()
    // The deep link goes to Organization → Storage, which every member can read
    // — not to a settings control the tenant does not have.
    expect(screen.getByRole('link')).toHaveAttribute('href', '/app/organization/storage')
  })

  test('names no actor — the platform is not a colleague', () => {
    render(<InboxItemRow item={storageAlert()} />)

    // The mention rows read "<Name> asked for your input"; a system alert that
    // fell back to the actor placeholder would invent a person.
    expect(screen.queryByText(/Someone/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Anna Weber/)).not.toBeInTheDocument()
  })

  test('still reads correctly after a re-crossing bumps the count', () => {
    // A recovery archives the row; the next crossing REVIVES it, so `count`
    // arrives at 2. The type ships a single `title` (no titleOne/titleMany), and
    // the count-aware key picker must fall back to it rather than dropping the
    // title entirely.
    render(<InboxItemRow item={storageAlert({ count: 2 })} />)

    expect(screen.getByText('Your organization is running out of storage')).toBeInTheDocument()
  })

  test('is tinted as needing attention without being an actionable request', () => {
    const { container } = render(<InboxItemRow item={storageAlert()} />)

    // `tone: 'warning'` shares the request tint — something needs attention —
    // but the row is not actionable, so it never sits in the "needs me" badge.
    expect(container.querySelector('.bg-warning-subtle')).not.toBeNull()
  })
})

describe('InboxItemRow — a version waiting for a decision (ADR-0054)', () => {
  const reviewRequest = (overrides: Partial<InboxItemView> = {}): InboxItemView =>
    item({
      id: 'i-review',
      type: 'document.review_requested',
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ver_2',
      actorName: 'Anna Weber',
      actorUserId: 'u-anna',
      // What the emission writes into the payload: the document's own name.
      subject: 'Brandschutzkonzept_Wohnbau-Nord.md',
      excerpt: null,
      href: '/app/projects/p1/files?doc=doc_1',
      ...overrides,
    })

  test('names the document and who is asking, and links to the file', () => {
    render(<InboxItemRow item={reviewRequest()} />)

    expect(
      screen.getByText('Anna Weber asked you to review Brandschutzkonzept_Wohnbau-Nord.md'),
    ).toBeInTheDocument()
    expect(screen.getByText('A new revision is waiting for your approval.')).toBeInTheDocument()
    // The deep links are the document's own — the title row and the explicit
    // open control both land on the pane where the review controls are.
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/app/projects/p1/files?doc=doc_1')
    }
  })

  test('reads as an outstanding request while it is open', () => {
    const { container } = render(<InboxItemRow item={reviewRequest()} />)
    expect(container.querySelector('.bg-warning-subtle')).not.toBeNull()
  })

  test('stops shouting once the decision has been taken', () => {
    // The backend resolves the round for every reviewer who was asked; the row
    // is then history, and colouring it would keep asking for something that
    // has already happened.
    const { container } = render(<InboxItemRow item={reviewRequest({ state: 'resolved' })} />)
    expect(container.querySelector('.bg-warning-subtle')).toBeNull()
  })
})

describe('InboxItemRow — inline review decisions (triage without Files)', () => {
  const reviewRequest = (overrides: Partial<InboxItemView> = {}): InboxItemView =>
    item({
      id: 'i-review',
      type: 'document.review_requested',
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ver_2',
      actorName: 'Anna Weber',
      actorUserId: 'u-anna',
      subject: 'Brandschutzkonzept_Wohnbau-Nord.md',
      excerpt: 'Bitte die Fluchtweglänge prüfen.',
      href: '/app/projects/p1/files?doc=doc_1',
      ...overrides,
    })

  const reviewVersion = {
    id: 'ver_2',
    documentId: 'doc_1',
    versionNumber: 2,
    state: 'in_review',
    archived: false,
    contentType: 'text/markdown',
    fileSize: 1200,
    contentHash: 'sha256:abc',
    submittedBy: 'u-anna',
    submittedAt: '2026-07-24T09:00:00Z',
    reviewedBy: null,
    reviewedAt: null,
    approvedBy: null,
    approvedAt: null,
    publishedBy: null,
    publishedAt: null,
    reviewComment: null,
    createdBy: 'u-anna',
    createdAt: '2026-07-24T09:00:00Z',
    updatedAt: '2026-07-24T09:00:00Z',
  }

  const reviewClient = (overrides: Record<string, unknown> = {}) => ({
    approve: vi.fn().mockResolvedValue({}),
    requestChanges: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
    getVersion: vi.fn().mockResolvedValue(reviewVersion),
    ...overrides,
  })

  // The STAND read fires with the row and settles on microtasks. Flush it
  // before interacting so the `ifMatch` each decision sends is deterministic
  // — which STAND the test acts on — rather than a race between the clicks
  // below and the promise.
  const settleState = () => act(async () => {})

  test('offers the three decisions and the file beside them', () => {
    render(<InboxItemRow item={reviewRequest()} reviewClient={reviewClient()} />)

    expect(screen.getByTestId('inbox-review-approve')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-review-request-changes')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-review-reject')).toBeInTheDocument()
    // The order excerpt stays visible, and the file opens from the row.
    expect(screen.getByText('Bitte die Fluchtweglänge prüfen.')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-review-open')).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=doc_1',
    )
  })

  test('approval is signed, never one click', async () => {
    const client = reviewClient()
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)
    await settleState()

    fireEvent.click(screen.getByTestId('inbox-review-approve'))
    expect(client.approve).not.toHaveBeenCalled()
    // The Fassung number is required: the stand already names which version
    // the signature releases, and the send stays shut until it is signed.
    await waitFor(() =>
      expect(screen.getByTestId('inbox-review-approve-as-of')).toHaveTextContent('revision 2'),
    )
    const send = screen.getByTestId('inbox-review-approve-send')
    expect(send).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'I approve this revision' }))
    expect(send).toBeEnabled()
    fireEvent.click(send)

    expect(client.approve).toHaveBeenCalledWith('doc_1', 'ver_2', undefined, 'sha256:abc')
    expect(await screen.findByTestId('inbox-review-decided')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-review-approve')).not.toBeInTheDocument()
  })

  test('approval waits for the STAND: no Fassung number, no signature', async () => {
    // Bestimmtheit: with the read still in flight the stand is unnamed ('…')
    // and the send stays shut even once signed — a liability act without a
    // named Fassung is void.
    const client = reviewClient({ getVersion: vi.fn().mockReturnValue(new Promise(() => {})) })
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)

    fireEvent.click(screen.getByTestId('inbox-review-approve'))
    expect(screen.getByTestId('inbox-review-approve-as-of')).toHaveTextContent('…')
    fireEvent.click(screen.getByRole('checkbox', { name: 'I approve this revision' }))
    expect(screen.getByTestId('inbox-review-approve-send')).toBeDisabled()
    expect(client.approve).not.toHaveBeenCalled()
  })

  test('a failed STAND read says so, blocks the signature, and retries', async () => {
    // The read failure used to be a silent dead end: the stand stayed '…' and
    // the send stayed shut with nothing saying why. The row must name it and
    // offer the retry, and must never fall back to approving without ifMatch.
    const client = reviewClient({
      getVersion: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(reviewVersion),
    })
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)

    fireEvent.click(screen.getByTestId('inbox-review-approve'))
    expect(await screen.findByTestId('inbox-review-stand-failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'I approve this revision' }))
    expect(screen.getByTestId('inbox-review-approve-send')).toBeDisabled()
    expect(client.approve).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('inbox-review-stand-retry'))

    await waitFor(() =>
      expect(screen.getByTestId('inbox-review-approve-as-of')).toHaveTextContent('revision 2'),
    )
    expect(screen.queryByTestId('inbox-review-stand-failed')).toBeNull()
    expect(screen.getByTestId('inbox-review-approve-send')).toBeEnabled()
  })

  test('approval names the stand, the actor, the acting moment and the date — like the file pane', async () => {
    // The STAND read settles first under real timers (`findBy`/`waitFor` poll
    // on timers, so freezing them first would hang the wait below); only then
    // is the clock frozen, so the acting line — which stamps the viewer's own
    // press — is asserted in full, never just its prefix.
    render(<InboxItemRow item={reviewRequest()} reviewClient={reviewClient()} />)
    await settleState()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T10:00:00Z'))
    try {
      fireEvent.click(screen.getByTestId('inbox-review-approve'))

      // Which stand: the document, its Fassung number (required — file-pane
      // parity) and when the round opened (≈ submission).
      expect(screen.getByTestId('inbox-review-approve-as-of')).toHaveTextContent(
        `Brandschutzkonzept_Wohnbau-Nord.md · revision 2 · as of ${formatAbsoluteTime('2026-07-24T09:00:00Z', 'en')}`,
      )
      // Actor identity: whose request this stand answers — no name is stamped
      // on the acting line itself (none is known here), so the row title carries it.
      expect(
        screen.getByText('Anna Weber asked you to review Brandschutzkonzept_Wohnbau-Nord.md'),
      ).toBeInTheDocument()
      // Who acts when: the viewer signs now — the full stamped moment, date and all.
      expect(screen.getByTestId('inbox-review-approve-acting').textContent).toBe(
        `Acting: ${formatAbsoluteTime('2026-08-04T10:00:00Z', 'en')}`,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  test('requesting changes requires words', async () => {
    const client = reviewClient()
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)
    await settleState()

    fireEvent.click(screen.getByTestId('inbox-review-request-changes'))
    // The STAND read runs when the decision opens; its `contentHash` rides the
    // call below as `ifMatch`, so a stale row 409s instead of refusing bytes
    // the reviewer never saw.
    await waitFor(() => expect(client.getVersion).toHaveBeenCalled())
    const send = screen.getByTestId('inbox-review-comment-send')
    expect(send).toBeDisabled()
    expect(client.requestChanges).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Die Fluchtweglänge fehlt.' },
    })
    fireEvent.click(send)

    await waitFor(() =>
      expect(client.requestChanges).toHaveBeenCalledWith(
        'doc_1',
        'ver_2',
        'Die Fluchtweglänge fehlt.',
        undefined,
        'sha256:abc',
      ),
    )
    expect(await screen.findByTestId('inbox-review-decided')).toBeInTheDocument()
  })

  test('rejecting requires a reason', async () => {
    const client = reviewClient()
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)
    await settleState()

    fireEvent.click(screen.getByTestId('inbox-review-reject'))
    await waitFor(() => expect(client.getVersion).toHaveBeenCalled())
    expect(screen.getByText('Reason for rejection')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Falsches Gebäude.' },
    })
    fireEvent.click(screen.getByTestId('inbox-review-comment-send'))

    await waitFor(() =>
      expect(client.reject).toHaveBeenCalledWith('doc_1', 'ver_2', 'Falsches Gebäude.', 'sha256:abc'),
    )
    expect(await screen.findByTestId('inbox-review-decided')).toBeInTheDocument()
  })

  test('a refused decision says so and keeps the row decidable', async () => {
    const client = reviewClient({ approve: vi.fn().mockRejectedValue(new Error('403')) })
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)
    await settleState()

    fireEvent.click(screen.getByTestId('inbox-review-approve'))
    expect(await screen.findByTestId('inbox-review-approve-as-of')).toHaveTextContent('revision 2')
    fireEvent.click(screen.getByRole('checkbox', { name: 'I approve this revision' }))
    fireEvent.click(screen.getByTestId('inbox-review-approve-send'))

    expect(await screen.findByTestId('inbox-review-failed')).toBeInTheDocument()
    // One error red: the product `text-error` token, like every other surface.
    expect(screen.getByTestId('inbox-review-failed')).toHaveClass('text-error')
    // Nothing settled: the decisions stay offered for a retry.
    expect(screen.getByTestId('inbox-review-approve-confirm')).toBeInTheDocument()
  })

  test('a stale STAND surfaces distinctly, with the file as the way back', async () => {
    // Somebody decided first, or the bytes changed under the row: the server
    // 409s with the current STAND, and the row must not dress that as a
    // generic failure — it names the move and links where the current Fassung
    // lives, and it keeps the confirm offered for a retry once re-read.
    const client = reviewClient({
      approve: vi
        .fn()
        .mockRejectedValue(new DocumentLifecycleError(409, 'CONFLICT', 'state changed')),
    })
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)
    await settleState()

    fireEvent.click(screen.getByTestId('inbox-review-approve'))
    expect(await screen.findByTestId('inbox-review-approve-as-of')).toHaveTextContent('revision 2')
    fireEvent.click(screen.getByRole('checkbox', { name: 'I approve this revision' }))
    fireEvent.click(screen.getByTestId('inbox-review-approve-send'))

    expect(await screen.findByTestId('inbox-review-stale')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-review-failed')).not.toBeInTheDocument()
    expect(screen.getByTestId('inbox-review-reload')).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=doc_1',
    )
    expect(screen.getByTestId('inbox-review-approve-confirm')).toBeInTheDocument()
  })

  test('no inline decisions once the round is settled, unreachable, or anchorless', () => {
    const { unmount } = render(
      <InboxItemRow item={reviewRequest({ state: 'resolved' })} reviewClient={reviewClient()} />,
    )
    expect(screen.queryByTestId('inbox-review-actions')).not.toBeInTheDocument()
    unmount()

    render(
      <InboxItemRow
        item={reviewRequest({ state: 'inert', href: null })}
        reviewClient={reviewClient()}
      />,
    )
    expect(screen.queryByTestId('inbox-review-actions')).not.toBeInTheDocument()
  })

  test('no inline decisions without a version anchor, a Fassung name, or on other types', () => {
    const { unmount } = render(
      <InboxItemRow item={reviewRequest({ anchorId: null })} reviewClient={reviewClient()} />,
    )
    expect(screen.queryByTestId('inbox-review-actions')).not.toBeInTheDocument()
    unmount()

    // The signature releases a NAMED Fassung: without a subject the confirm
    // could not say which document it releases, so no decisions are offered.
    const { unmount: unmountSecond } = render(
      <InboxItemRow item={reviewRequest({ subject: null })} reviewClient={reviewClient()} />,
    )
    expect(screen.queryByTestId('inbox-review-actions')).not.toBeInTheDocument()
    unmountSecond()

    render(<InboxItemRow item={item()} reviewClient={reviewClient()} />)
    expect(screen.queryByTestId('inbox-review-actions')).not.toBeInTheDocument()
  })
})
describe('InboxItemRow — a row whose target is a document', () => {
  const reviewRequest = (overrides: Partial<InboxItemView> = {}): InboxItemView =>
    item({
      type: 'document.review_requested',
      resourceType: 'document',
      resourceId: 'doc-7',
      anchorId: 'ver-7',
      href: '/app/projects/p1/files?doc=doc-7',
      subject: 'Befund Fluchtwege',
      excerpt: null,
      ...overrides,
    })

  test('offers Besprechen beside the link that opens the file', () => {
    // A reviewer has two next moves — open the file, or ask about it — and only
    // the first had a control. The second used to be impossible anyway: a
    // submitted draft has no chunks, so Piloti could not answer about it.
    render(<InboxItemRow item={reviewRequest()} />)
    expect(screen.getByTestId('discuss-document')).toBeInTheDocument()
  })

  test('does not switch on the item type, only on what the row points at', () => {
    // The registry is the only thing that decides how a row LOOKS; this control
    // is keyed on `resourceType`, which every row already carries.
    render(<InboxItemRow item={item()} />)
    expect(screen.queryByTestId('discuss-document')).not.toBeInTheDocument()
  })

  test('offers nothing on an inert row, whose target is gone', () => {
    // Same reason the title is not a link there: a working-looking control
    // pointing at content this reader may no longer reach (IB-13/IB-14).
    render(<InboxItemRow item={reviewRequest({ state: 'inert', href: null })} />)
    expect(screen.queryByTestId('discuss-document')).not.toBeInTheDocument()
  })

  test('offers nothing for an Archiv document, which has no project chat', () => {
    render(<InboxItemRow item={reviewRequest({ href: '/app/archiv?doc=doc-7' })} />)
    expect(screen.queryByTestId('discuss-document')).not.toBeInTheDocument()
  })
})

describe('InboxItemRow — a new Fassung (document.new_revision)', () => {
  const newRevision = (overrides: Partial<InboxItemView> = {}) =>
    item({
      type: 'document.new_revision',
      state: 'unread',
      archived: false,
      actionable: false,
      resourceType: 'document',
      resourceId: 'doc-b',
      anchorId: 'doc-a',
      actorName: 'Anna Weber',
      actorUserId: 'u-anna',
      href: '/app/projects/p1/files?doc=doc-b',
      subject: 'Grundriss EG A',
      related: 'Grundriss EG B',
      excerpt: 'Wand im EG verschoben.',
      ...overrides,
    })

  test('is a sentence about the person who uploaded it, with what changed as its only body', () => {
    render(<InboxItemRow item={newRevision()} />)
    expect(screen.getByText('Anna Weber uploaded a new revision of “Grundriss EG A”')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-item-excerpt')).toHaveTextContent('Wand im EG verschoben.')
    // No sentence above the excerpt repeating that something changed, so the
    // excerpt gets the three lines a phone needs to say what.
    expect(screen.queryByText(/to see what changed/)).not.toBeInTheDocument()
    expect(screen.getByTestId('inbox-item-excerpt')).toHaveClass('line-clamp-3')
    expect(screen.getByRole('link', { name: /uploaded a new revision/ })).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=doc-b',
    )
  })

  test('reads in German as a sentence about the person', () => {
    renderPlain(
      <I18nProvider initialLocale="de" fixedLocale>
        <InboxItemRow item={newRevision()} />
      </I18nProvider>,
    )
    expect(screen.getByText('Anna Weber hat eine neue Fassung von „Grundriss EG A“ hochgeladen')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-compare-revisions')).toHaveTextContent('Fassungen vergleichen')
  })

  test('offers „Compare revisions" first, opening the newer document with the comparison against the older', () => {
    const onOpen = vi.fn()
    render(<InboxItemRow item={newRevision()} onOpen={onOpen} />)
    const compare = screen.getByTestId('inbox-compare-revisions')
    expect(compare).toHaveAttribute('href', '/app/projects/p1/files?doc=doc-b&compare=doc-a')
    expect(compare).toHaveAccessibleName('Compare the new and the older revision of “Grundriss EG A”')
    // „Discuss" stays, after it: the secondary move.
    const discuss = screen.getByTestId('discuss-document')
    expect(compare.compareDocumentPosition(discuss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(compare)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test('says how many open marks the new Fassung leaves to check, and from which Fassung', () => {
    const same = { related: null, resourceId: 'doc-a', anchorId: 'ver-3', excerpt: null }
    const de = (row: InboxItemView) =>
      renderPlain(
        <I18nProvider initialLocale="de" fixedLocale>
          <InboxItemRow item={row} />
        </I18nProvider>,
      )
    const many = de(newRevision({ ...same, variant: 'marks', openMarks: 4, marksRevision: 2 }))
    expect(screen.getByText('4 offene Anmerkungen aus Fassung 2 prüfen')).toBeInTheDocument()
    many.unmount()

    // Beside what changed, and from another document: „the previous Fassung".
    de(newRevision({ variant: 'mark_earlier', openMarks: 1, marksRevision: null }))
    expect(screen.getByText('1 offene Anmerkung aus der vorigen Fassung prüfen')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-item-excerpt')).toHaveTextContent('Wand im EG verschoben.')
  })

  test('says where the change is when there is no excerpt', () => {
    render(<InboxItemRow item={newRevision({ excerpt: null })} />)
    expect(screen.getByText('Open the revision to see what changed.')).toBeInTheDocument()
  })

  test('without a known actor, it does not say „Someone uploaded"', () => {
    render(<InboxItemRow item={newRevision({ actorName: null })} />)
    expect(screen.getByText('New revision of “Grundriss EG A”')).toBeInTheDocument()
    expect(screen.queryByText(/Someone/)).not.toBeInTheDocument()
  })

  test('a same-name version has no second document, so nothing to lay side by side', () => {
    render(<InboxItemRow item={newRevision({ related: null, resourceId: 'doc-a', anchorId: 'ver-2', excerpt: null })} />)
    expect(screen.getByText('Anna Weber uploaded a new revision of “Grundriss EG A”')).toBeInTheDocument()
    expect(screen.queryByText(/Grundriss EG B/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('inbox-compare-revisions')).not.toBeInTheDocument()
  })

  test('a row the reader can no longer reach names neither document and is not a link', () => {
    render(<InboxItemRow item={newRevision({ href: null, subject: null, related: null, excerpt: null })} />)
    expect(screen.queryByText(/Grundriss EG/)).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})

describe('InboxItemRow — what Piloti did, in the reader’s words', () => {
  const onMark = (overrides: Partial<InboxItemView> = {}) =>
    item({
      type: 'piloti.work_done',
      state: 'unread',
      archived: false,
      actionable: false,
      resourceType: 'document',
      resourceId: 'doc-eg',
      anchorId: 'mark-4',
      actorName: null,
      actorUserId: null,
      href: '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4',
      subject: 'Grundriss EG',
      related: '4',
      excerpt: 'Türbreite prüfen',
      variant: null,
      ...overrides,
    })

  const german = (row: InboxItemView) =>
    renderPlain(
      <I18nProvider initialLocale="de" fixedLocale>
        <InboxItemRow item={row} />
      </I18nProvider>,
    )

  test('a finished mark names the mark and the document, says it was for the reader, and what to do', () => {
    german(onMark())
    expect(screen.getByText('Piloti hat Anmerkung 4 in „Grundriss EG“ für Sie bearbeitet')).toBeInTheDocument()
    expect(screen.getByText('Lesen Sie die Antwort im Verlauf der Anmerkung.')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-item-excerpt')).toHaveTextContent('Türbreite prüfen')
    expect(screen.getByTestId('inbox-item-link')).toHaveAttribute('href', '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4')
  })

  test('without a document name it still names the mark, never „Chat ohne Titel“', () => {
    german(onMark({ subject: null }))
    expect(screen.getByText('Piloti hat Anmerkung 4 für Sie bearbeitet')).toBeInTheDocument()
    expect(screen.queryByText(/Chat ohne Titel/)).not.toBeInTheDocument()
  })

  test.each([
    ['budget', /Das Nutzungsbudget ist aufgebraucht\..*Organisation → Nutzung & Budgets/],
    ['busy', /Piloti kam nicht rechtzeitig dazu.*später noch einmal/],
    ['access', /Piloti konnte sich nicht in Ihrem Namen anmelden\./],
    ['error', /Die Bearbeitung brach ab, bevor eine Antwort da war\./],
  ] as const)('a failure says why (%s) and what the reader can do', (variant, body) => {
    german(onMark({ type: 'piloti.work_failed', variant }))
    expect(screen.getByText('Piloti konnte Anmerkung 4 in „Grundriss EG“ nicht bearbeiten')).toBeInTheDocument()
    expect(screen.getByText(body)).toBeInTheDocument()
  })

  test('a failure stored before the reason was kept reads the general sentence', () => {
    german(onMark({ type: 'piloti.work_failed', variant: null }))
    expect(
      screen.getByText('Öffnen Sie die Anmerkung: Bitten Sie Piloti noch einmal darum oder bearbeiten Sie sie selbst.'),
    ).toBeInTheDocument()
  })

  test('a variant the build has no words for reads the type’s general wording', () => {
    german(onMark({ type: 'piloti.work_failed', variant: 'quota_from_the_future' }))
    expect(screen.getByText('Piloti konnte Anmerkung 4 in „Grundriss EG“ nicht bearbeiten')).toBeInTheDocument()
    expect(screen.getByText(/Bitten Sie Piloti noch einmal darum oder bearbeiten Sie sie selbst/)).toBeInTheDocument()
  })

  test('a delegation handed back says the mark is with the reader again', () => {
    german(onMark({ variant: 'assigned' }))
    expect(screen.getByText('Piloti hat Anmerkung 4 in „Grundriss EG“ für Sie bearbeitet')).toBeInTheDocument()
    expect(screen.getByText('Die Anmerkung liegt wieder bei Ihnen.')).toBeInTheDocument()
  })

  test('a Piloti row wears Piloti’s glyph, and a person’s row its type icon', () => {
    const { unmount } = german(onMark())
    expect(document.querySelector('[data-slot="piloti-glyph"]')).not.toBeNull()
    unmount()

    german(onMark({ type: 'annotation.activity', actorName: 'Anna Weber', variant: 'reply' }))
    expect(document.querySelector('[data-slot="piloti-glyph"]')).toBeNull()
  })

  test('a Rückfrage asks the reader, with the question below', () => {
    german(onMark({ type: 'piloti.asks_you', actionable: true, excerpt: 'Ist die Brüstungshöhe hier 1,00 m?' }))
    expect(screen.getByText('Piloti hat eine Rückfrage an Sie zu Anmerkung 4 in „Grundriss EG“')).toBeInTheDocument()
    expect(screen.getByText('Piloti wartet auf Ihre Antwort. Antworten Sie im Verlauf der Anmerkung.')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-item-excerpt')).toHaveTextContent('Ist die Brüstungshöhe hier 1,00 m?')
  })

  test('a proposal says what it changes, and that nothing changes until the reader decides', () => {
    german(
      onMark({
        type: 'piloti.proposal_waiting',
        actionable: true,
        resourceType: 'conversation',
        resourceId: 'c1',
        anchorId: 'prop-1',
        href: '/app/projects/p1/chat?session=c1',
        subject: null,
        related: null,
        excerpt: 'Grundriss.pdf, Schnitt.pdf +1',
        variant: 'rename',
      }),
    )
    expect(screen.getByText('Piloti schlägt eine Umbenennung vor')).toBeInTheDocument()
    expect(
      screen.getByText('Der Vorschlag steht im Chat. Übernehmen oder verwerfen Sie ihn dort; bis dahin ändert sich nichts.'),
    ).toBeInTheDocument()
  })

  test('mirrors the meaning in English', () => {
    render(<InboxItemRow item={onMark({ type: 'piloti.work_failed', variant: 'budget' })} />)
    expect(screen.getByText('Piloti could not work on annotation 4 in “Grundriss EG”')).toBeInTheDocument()
    expect(screen.getByText(/The usage budget is used up\./)).toBeInTheDocument()
  })

  test('a redacted row names neither the mark nor why', () => {
    german(onMark({ type: 'piloti.work_failed', href: null, subject: null, related: null, excerpt: null, variant: null }))
    expect(screen.getByText('Piloti konnte eine Anmerkung nicht bearbeiten')).toBeInTheDocument()
    // Not „Dieser Chat …": the row points at a mark in a document.
    expect(screen.getByText('Das ist für Sie nicht mehr verfügbar.')).toBeInTheDocument()
  })
})

describe('InboxItemRow — a colleague’s work on a mark, in the reader’s words', () => {
  const onMark = (overrides: Partial<InboxItemView> = {}) =>
    item({
      type: 'annotation.assigned_to_you',
      state: 'unread',
      archived: false,
      actionable: true,
      resourceType: 'document',
      resourceId: 'doc-eg',
      anchorId: 'mark-4',
      actorName: 'Anna Weber',
      actorUserId: 'u-anna',
      href: '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4',
      subject: 'Grundriss EG',
      related: '4',
      excerpt: 'Türbreite prüfen',
      variant: 'person',
      ...overrides,
    })

  const german = (row: InboxItemView) =>
    renderPlain(
      <I18nProvider initialLocale="de" fixedLocale>
        <InboxItemRow item={row} />
      </I18nProvider>,
    )

  test('being made responsible names who, which mark in which document, and what to do', () => {
    german(onMark())
    expect(screen.getByText('Anna Weber hat Ihnen Anmerkung 4 in „Grundriss EG“ zugewiesen')).toBeInTheDocument()
    expect(
      screen.getByText('Sie sind dafür zuständig. Antworten Sie im Verlauf oder erledigen Sie die Anmerkung.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('inbox-item-excerpt')).toHaveTextContent('Türbreite prüfen')
    expect(screen.getByTestId('inbox-item-link')).toHaveAttribute('href', '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4')
  })

  test('says Piloti did it for the colleague when Piloti assigned it', () => {
    german(onMark({ variant: 'piloti' }))
    expect(screen.getByText('Piloti hat Ihnen für Anna Weber Anmerkung 4 in „Grundriss EG“ zugewiesen')).toBeInTheDocument()
  })

  test('says by when the Zuständige is responsible, when the mark has a date', () => {
    german(onMark({ dueOn: '2026-10-24' }))
    expect(
      screen.getByText('Sie sind dafür zuständig, bis 24. Okt. 2026. Antworten Sie im Verlauf oder erledigen Sie die Anmerkung.'),
    ).toBeInTheDocument()
  })

  test.each([
    ['due', '2026-10-31', 'Anna Weber hat die Frist von Anmerkung 4 in „Grundriss EG“ auf 31. Okt. 2026 gesetzt'],
    ['due_cleared', null, 'Anna Weber hat die Frist von Anmerkung 4 in „Grundriss EG“ entfernt'],
    ['due_piloti', '2026-10-31', 'Piloti hat für Anna Weber die Frist von Anmerkung 4 in „Grundriss EG“ auf 31. Okt. 2026 gesetzt'],
  ] as const)('tells the Zuständige the date moved (%s)', (variant, dueOn, title) => {
    german(onMark({ variant, dueOn }))
    expect(screen.getByText(title)).toBeInTheDocument()
  })

  test('the daily reminder says the date is near, then that it has passed, in the same row', () => {
    const reminder = { actorName: null, actorUserId: null, dueOn: '2026-10-18' }
    const soon = german(onMark({ ...reminder, variant: 'due_soon' }))
    expect(screen.getByText('Anmerkung 4 in „Grundriss EG“ ist am 18. Okt. 2026 fällig')).toBeInTheDocument()
    soon.unmount()

    german(onMark({ ...reminder, variant: 'overdue' }))
    expect(screen.getByText('Anmerkung 4 in „Grundriss EG“ war am 18. Okt. 2026 fällig')).toBeInTheDocument()
    expect(screen.getByText(/die Frist ist abgelaufen/)).toBeInTheDocument()
  })

  test('counts replies on one mark in one row, and reads a read row without „neu“', () => {
    const reply = { type: 'annotation.activity' as const, actionable: false, variant: 'reply', excerpt: 'Ist bestellt.' }
    const { unmount } = german(onMark({ ...reply, count: 1 }))
    expect(screen.getByText('Anna Weber hat zu Anmerkung 4 in „Grundriss EG“ geantwortet')).toBeInTheDocument()
    unmount()

    const many = german(onMark({ ...reply, count: 3 }))
    expect(screen.getByText('3 neue Antworten zu Anmerkung 4 in „Grundriss EG“, zuletzt von Anna Weber')).toBeInTheDocument()
    many.unmount()

    const noName = german(onMark({ ...reply, count: 3, subject: null }))
    expect(screen.getByText('3 neue Antworten zu Anmerkung 4, zuletzt von Anna Weber')).toBeInTheDocument()
    noName.unmount()

    // Piloti's reply carries no person: the title says what arrived, never „Jemand“.
    const piloti = german(onMark({ ...reply, count: 1, actorName: null, actorUserId: null }))
    expect(screen.getByText('Neue Antwort zu Anmerkung 4 in „Grundriss EG“')).toBeInTheDocument()
    piloti.unmount()

    german(onMark({ ...reply, state: 'read', count: 0 }))
    expect(screen.getByText('Antworten zu Anmerkung 4 in „Grundriss EG“')).toBeInTheDocument()
  })

  test.each([
    ['resolved', 'Anna Weber hat Anmerkung 4 in „Grundriss EG“ erledigt'],
    ['dismissed', 'Anna Weber hat Anmerkung 4 in „Grundriss EG“ verworfen'],
    ['reopened', 'Anna Weber hat Anmerkung 4 in „Grundriss EG“ wieder geöffnet'],
  ] as const)('tells the author someone else %s their mark', (variant, title) => {
    german(onMark({ type: 'annotation.activity', actionable: false, variant, count: 2 }))
    expect(screen.getByText(title)).toBeInTheDocument()
  })

  test('being mentioned names who, which mark in which document, and quotes what they wrote', () => {
    german(onMark({ type: 'annotation.mentioned', variant: null, excerpt: '@Miriam Hofer bitte die Breite prüfen' }))
    expect(screen.getByText('Anna Weber hat Sie in Anmerkung 4 in „Grundriss EG“ erwähnt')).toBeInTheDocument()
    expect(screen.getByText('Antworten Sie im Verlauf der Anmerkung.')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-item-excerpt')).toHaveTextContent('@Miriam Hofer bitte die Breite prüfen')
    expect(screen.getByTestId('inbox-item-link')).toHaveAttribute('href', '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4')
  })

  test('quotes the mention as the thread’s chip, louder for the reader, and a name only typed as text', () => {
    renderPlain(
      <I18nProvider initialLocale="de" fixedLocale>
        <InboxItemRow
          viewerId="u-miriam"
          item={onMark({
            type: 'annotation.mentioned',
            variant: null,
            excerpt: '@Miriam Hofer und @Jakob Huber, bitte mit @Max prüfen',
            mentions: [
              { targetId: 'u-miriam', display: 'Miriam Hofer' },
              { targetId: 'u-jakob', display: 'Jakob Huber' },
            ],
          })}
        />
      </I18nProvider>,
    )
    const excerpt = screen.getByTestId('inbox-item-excerpt')
    const chips = within(excerpt).getAllByTestId('mention-chip')
    expect(chips.map((chip) => [chip.textContent, chip.getAttribute('data-mention-me')])).toEqual([
      ['@Miriam Hofer', 'true'],
      ['@Jakob Huber', 'false'],
    ])
    expect(excerpt).toHaveTextContent('@Miriam Hofer und @Jakob Huber, bitte mit @Max prüfen')
  })
})

describe('InboxItemRow — a row about a mark acts on the mark', () => {
  const markRow = (overrides: Partial<InboxItemView> = {}) =>
    item({
      type: 'annotation.assigned_to_you',
      state: 'unread',
      archived: false,
      actionable: true,
      resourceType: 'document',
      resourceId: 'doc-eg',
      anchorId: 'mark-4',
      actorName: 'Anna Weber',
      actorUserId: 'u-anna',
      href: '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4',
      subject: 'Grundriss EG',
      related: '4',
      excerpt: 'Türbreite prüfen',
      variant: null,
      // The server's word: this reader may write the document, so they answer from the row.
      answerIn: 'row',
      ...overrides,
    })

  /** What the reply route answers: the mark with its thread, the new reply's id, and the wake. */
  const answered = (wake: 'none' | 'off' | 'queued', mentions: Array<{ targetId: string; display: string }> = []) =>
    ({ annotation: { replies: [{ id: 'reply-1', mentions }] }, replyId: 'reply-1', wake }) as never

  const client = (overrides: Partial<InboxMarkClient> = {}): InboxMarkClient => ({
    reply: vi.fn(async () => answered('none')),
    update: vi.fn(async () => ({}) as never),
    ...overrides,
  })

  const JAKOB = { userId: 'u-jakob', name: 'Jakob Huber', email: null, profilePictureUrl: null }
  /** The „@" picker's row for one person (or Piloti), as the chat's picker draws it. */
  const pickerOption = (targetId: string): HTMLElement => {
    const row = screen
      .getAllByTestId('mention-option')
      .find((option) => option.getAttribute('data-target-id') === targetId)
    if (!row) throw new Error(`no picker row for ${targetId}`)
    return row
  }

  const candidates = () =>
    server.use(http.get('/api/assignments/:type/:id/candidates', () => HttpResponse.json({ candidates: [JAKOB] })))

  test('leads with „Go to annotation“, which opens the mark and marks the row read, and offers no chat about the document', () => {
    const onOpen = vi.fn()
    render(<InboxItemRow item={markRow()} onOpen={onOpen} />)
    const open = screen.getByTestId('inbox-open-mark')
    expect(open).toHaveTextContent('Go to annotation')
    expect(open).toHaveAttribute('href', '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4')
    expect(screen.queryByTestId('discuss-document')).not.toBeInTheDocument()
    fireEvent.click(open)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }))
  })

  test('says „To the annotations“ on a row about several new marks, which opens the review at the newest', () => {
    const created = (count: number, variant: string) =>
      markRow({ type: 'annotation.activity', variant, count, answerIn: null, actionable: false })
    const { rerender } = render(<InboxItemRow item={created(15, 'created')} />)
    expect(screen.getByTestId('inbox-open-mark')).toHaveTextContent('To the annotations')
    rerender(<InboxItemRow item={created(3, 'created_piloti')} />)
    expect(screen.getByTestId('inbox-open-mark')).toHaveTextContent('To the annotations')
    // One new mark, or news about one mark, is one annotation.
    rerender(<InboxItemRow item={created(1, 'created')} />)
    expect(screen.getByTestId('inbox-open-mark')).toHaveTextContent('Go to annotation')
    rerender(<InboxItemRow item={created(4, 'reply')} />)
    expect(screen.getByTestId('inbox-open-mark')).toHaveTextContent('Go to annotation')
  })

  test('opens the mark with the Postfach as the page to return to, so closing the review comes back here', () => {
    page.pathname = '/app/inbox'
    page.search = 'filter=unread'
    try {
      render(<InboxItemRow item={markRow()} />)
      const back = encodeURIComponent('/app/inbox?filter=unread')
      expect(screen.getByTestId('inbox-open-mark')).toHaveAttribute(
        'href',
        `/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4&back=${back}`
      )
      expect(screen.getByTestId('inbox-item-link')).toHaveAttribute(
        'href',
        `/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4&back=${back}`
      )
    } finally {
      page.pathname = '/'
      page.search = ''
    }
  })

  test('answers an assigned mark through the annotations client, and the answered row is read', async () => {
    const marks = client()
    const onOpen = vi.fn()
    render(<InboxItemRow item={markRow()} onOpen={onOpen} markClient={marks} />)
    fireEvent.click(screen.getByTestId('inbox-mark-reply'))
    fireEvent.change(screen.getByLabelText('Your reply to annotation 4'), { target: { value: '  Ist bestellt.  ' } })
    fireEvent.click(screen.getByTestId('inbox-mark-reply-box-send'))
    await waitFor(() => expect(screen.getByTestId('inbox-mark-outcome')).toHaveTextContent('Reply sent.'))
    expect(marks.reply).toHaveBeenCalledWith('doc-eg', 'mark-4', { body: 'Ist bestellt.' })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test('answers a mention in the mark’s thread from the row, and offers no resolving: being asked is not being responsible', async () => {
    const marks = client()
    render(<InboxItemRow item={markRow({ type: 'annotation.mentioned' })} markClient={marks} />)
    expect(screen.queryByTestId('inbox-mark-resolve')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('inbox-mark-reply'))
    fireEvent.change(screen.getByLabelText('Your reply to annotation 4'), { target: { value: 'Passt.' } })
    fireEvent.click(screen.getByTestId('inbox-mark-reply-box-send'))
    await waitFor(() => expect(marks.reply).toHaveBeenCalledWith('doc-eg', 'mark-4', { body: 'Passt.' }))
  })

  describe('„Resolve“ holds its write for the undo window', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    /** Let the held write's promise settle inside React's act. */
    const settle = () => act(async () => {})

    test('says it at once, offers „Undo“ while the row stays, and writes only when the window ends', async () => {
      const marks = client()
      const { rerender } = render(<InboxItemRow item={markRow()} markClient={marks} />)
      fireEvent.click(screen.getByTestId('inbox-mark-resolve'))

      expect(screen.getByTestId('inbox-mark-outcome')).toHaveTextContent('Marked as resolved. Undo')
      expect(marks.update).not.toHaveBeenCalled()
      // Nothing was written, so the request is still open and the list's re-read keeps the row: „Undo“ stays usable.
      rerender(<InboxItemRow item={markRow({ state: 'read' })} markClient={marks} />)
      expect(screen.getByTestId('inbox-mark-undo')).toBeEnabled()
      act(() => {
        vi.advanceTimersByTime(ARCHIVE_UNDO_MS - 1)
      })
      expect(marks.update).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(1)
      })
      await settle()
      expect(marks.update).toHaveBeenCalledTimes(1)
      expect(marks.update).toHaveBeenCalledWith('doc-eg', 'mark-4', { status: 'resolved', expectedStatus: 'open' })
      expect(screen.getByTestId('inbox-mark-outcome')).toHaveTextContent('Marked as resolved.')
      expect(screen.queryByTestId('inbox-mark-undo')).not.toBeInTheDocument()
    })

    test('„Undo“ inside the window writes nothing, and the focus follows the control that took the pressed one’s place', async () => {
      const marks = client()
      render(<InboxItemRow item={markRow()} markClient={marks} />)
      screen.getByTestId('inbox-mark-resolve').focus()
      fireEvent.click(screen.getByTestId('inbox-mark-resolve'))
      expect(screen.getByTestId('inbox-mark-undo')).toHaveFocus()

      fireEvent.click(screen.getByTestId('inbox-mark-undo'))
      expect(screen.queryByTestId('inbox-mark-outcome')).not.toBeInTheDocument()
      expect(screen.getByTestId('inbox-mark-resolve')).toHaveFocus()
      act(() => {
        vi.advanceTimersByTime(ARCHIVE_UNDO_MS * 2)
      })
      await settle()
      expect(marks.update).not.toHaveBeenCalled()
    })

    test('gives the focus to the outcome line once the window ends with the write, never to the page', async () => {
      const marks = client()
      render(<InboxItemRow item={markRow()} markClient={marks} />)
      screen.getByTestId('inbox-mark-resolve').focus()
      fireEvent.click(screen.getByTestId('inbox-mark-resolve'))
      expect(screen.getByTestId('inbox-mark-undo')).toHaveFocus()

      act(() => {
        vi.advanceTimersByTime(ARCHIVE_UNDO_MS)
      })
      await settle()
      expect(marks.update).toHaveBeenCalledTimes(1)
      // „Undo“ went and „Resolve“ is not drawn again: the line that says what happened holds the focus.
      expect(screen.queryByTestId('inbox-mark-resolve')).not.toBeInTheDocument()
      expect(screen.getByTestId('inbox-mark-outcome')).toHaveFocus()
    })

    test('says so in the row’s own words when the write that finally goes finds the mark moved', async () => {
      const marks = client({
        update: vi.fn(async () => {
          throw new AnnotationRequestError(409, 'CONFLICT', 'moved')
        }),
      })
      render(<InboxItemRow item={markRow()} markClient={marks} />)
      fireEvent.click(screen.getByTestId('inbox-mark-resolve'))
      act(() => {
        vi.advanceTimersByTime(ARCHIVE_UNDO_MS)
      })
      await settle()

      expect(marks.update).toHaveBeenCalledWith('doc-eg', 'mark-4', { status: 'resolved', expectedStatus: 'open' })
      expect(screen.getByTestId('inbox-mark-outcome')).toHaveTextContent(/Someone changed the annotation first/)
      expect(screen.getByTestId('inbox-mark-outcome')).toHaveAttribute('role', 'alert')
      expect(screen.queryByTestId('inbox-mark-undo')).not.toBeInTheDocument()
    })

    test('sends a held write when the row goes', () => {
      const marks = client()
      const { unmount } = render(<InboxItemRow item={markRow()} markClient={marks} />)
      fireEvent.click(screen.getByTestId('inbox-mark-resolve'))
      unmount()
      expect(marks.update).toHaveBeenCalledWith('doc-eg', 'mark-4', { status: 'resolved', expectedStatus: 'open' })
    })
  })

  test('answers Piloti’s question, but does not resolve the mark for it', () => {
    render(<InboxItemRow item={markRow({ type: 'piloti.asks_you', actorName: null, actorUserId: null })} markClient={client()} />)
    expect(screen.getByTestId('inbox-mark-reply')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-mark-resolve')).not.toBeInTheDocument()
  })

  // The row offers only what the reader can do: one who may only read the
  // document cannot answer or close the mark, so the row just opens it.
  test('offers neither answering nor resolving when the server says the reader may not answer the mark', () => {
    render(<InboxItemRow item={markRow({ answerIn: null })} markClient={client()} />)
    expect(screen.getByTestId('inbox-open-mark')).toHaveTextContent('Go to annotation')
    expect(screen.queryByTestId('inbox-mark-reply')).not.toBeInTheDocument()
    expect(screen.queryByTestId('inbox-mark-resolve')).not.toBeInTheDocument()
  })

  // With events not waking Piloti, an answer from the row would reach nobody:
  // the Prüfansicht asks Piloti itself, so the row leads there.
  test('leads Piloti’s question to the review when the answer must be asked from there, and claims no answer here', () => {
    render(
      <InboxItemRow
        item={markRow({ type: 'piloti.asks_you', actorName: null, actorUserId: null, answerIn: 'review' })}
        markClient={client()}
      />,
    )
    const open = screen.getByTestId('inbox-open-mark')
    expect(open).toHaveTextContent('Answer in the review')
    expect(open).toHaveAttribute('href', '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4')
    expect(screen.queryByTestId('inbox-mark-reply')).not.toBeInTheDocument()
  })

  test('says how to reach Piloti when an answer sent from the row met a wake rule nothing acts on', async () => {
    const marks = client({ reply: vi.fn(async () => answered('off')) })
    render(<InboxItemRow item={markRow()} markClient={marks} />)
    fireEvent.click(screen.getByTestId('inbox-mark-reply'))
    fireEvent.change(screen.getByLabelText('Your reply to annotation 4'), { target: { value: 'Ist bestellt.' } })
    fireEvent.click(screen.getByTestId('inbox-mark-reply-box-send'))
    await waitFor(() =>
      expect(screen.getByTestId('inbox-mark-outcome')).toHaveTextContent('Piloti reads it only once you ask it with @Piloti in the review.'),
    )
  })

  // The row's answer is the thread's composer: Enter sends, Shift+Enter breaks the line.
  test('sends on Enter and breaks the line on Shift+Enter, as the thread does', async () => {
    const marks = client()
    render(<InboxItemRow item={markRow()} markClient={marks} />)
    fireEvent.click(screen.getByTestId('inbox-mark-reply'))
    const box = screen.getByLabelText('Your reply to annotation 4')
    await userEvent.type(box, 'Ist bestellt.{Shift>}{Enter}{/Shift}Lieferung Freitag.')
    expect(marks.reply).not.toHaveBeenCalled()
    await userEvent.type(box, '{Enter}')
    await waitFor(() =>
      expect(marks.reply).toHaveBeenCalledWith('doc-eg', 'mark-4', { body: 'Ist bestellt.\nLieferung Freitag.' }),
    )
    expect(await screen.findByTestId('inbox-mark-outcome')).toHaveTextContent('Reply sent.')
    expect(screen.queryByTestId('inbox-mark-reply-form')).not.toBeInTheDocument()
  })

  test('gives the focus back to „Reply“ when the answer box is sent or let go, never to the page', async () => {
    const marks = client()
    const user = userEvent.setup()
    render(<InboxItemRow item={markRow()} markClient={marks} />)

    await user.click(screen.getByTestId('inbox-mark-reply'))
    expect(screen.getByLabelText('Your reply to annotation 4')).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('inbox-mark-reply')).toHaveFocus()

    await user.click(screen.getByTestId('inbox-mark-reply'))
    await user.click(screen.getByTestId('inbox-mark-reply-cancel'))
    expect(screen.getByTestId('inbox-mark-reply')).toHaveFocus()

    await user.click(screen.getByTestId('inbox-mark-reply'))
    await user.type(screen.getByLabelText('Your reply to annotation 4'), 'Ist bestellt.{Enter}')
    expect(await screen.findByTestId('inbox-mark-outcome')).toHaveTextContent('Reply sent.')
    expect(screen.getByTestId('inbox-mark-reply')).toHaveFocus()
  })

  test('mentions a colleague who may open the document, with whom it picked, and says whom the server did not tell', async () => {
    candidates()
    const marks = client({ reply: vi.fn(async () => answered('none')) })
    render(<InboxItemRow item={markRow()} markClient={marks} />)
    fireEvent.click(screen.getByTestId('inbox-mark-reply'))
    const box = screen.getByLabelText('Your reply to annotation 4')
    await userEvent.type(box, '@Ja')
    await userEvent.click(await waitFor(() => pickerOption('u-jakob')))
    await userEvent.type(box, 'bitte prüfen{Enter}')
    await waitFor(() =>
      expect(marks.reply).toHaveBeenCalledWith('doc-eg', 'mark-4', {
        body: '@Jakob Huber bitte prüfen',
        mentions: [{ targetId: 'u-jakob', display: 'Jakob Huber' }],
      }),
    )
    // The server kept nobody: Jakob cannot open the document after all.
    expect(await screen.findByTestId('inbox-mark-outcome')).toHaveTextContent('Jakob Huber was not told.')
  })

  test('offers @Piloti where events wake Piloti, and sends it as the reply’s flag', async () => {
    candidates()
    const marks = client({ reply: vi.fn(async () => answered('queued', [{ targetId: 'agent:piloti', display: 'Piloti' }])) })
    render(<InboxItemRow item={markRow({ pilotiWakes: true })} markClient={marks} />)
    fireEvent.click(screen.getByTestId('inbox-mark-reply'))
    fireEvent.click(screen.getByTestId('inbox-mark-reply-box-mention'))
    const box = screen.getByLabelText('Your reply to annotation 4')
    await userEvent.type(box, 'stimmt das?{Enter}')
    await waitFor(() =>
      expect(marks.reply).toHaveBeenCalledWith('doc-eg', 'mark-4', {
        body: '@Piloti stimmt das?',
        addressesPiloti: true,
        mentions: [{ targetId: 'agent:piloti', display: 'Piloti' }],
      }),
    )
  })

  test('offers no @Piloti where nothing would wake it', async () => {
    candidates()
    render(<InboxItemRow item={markRow({ pilotiWakes: false })} markClient={client()} />)
    fireEvent.click(screen.getByTestId('inbox-mark-reply'))
    expect(screen.queryByTestId('inbox-mark-reply-box-mention')).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Your reply to annotation 4'), '@')
    await waitFor(() => pickerOption('u-jakob'))
    expect(screen.getAllByTestId('mention-option').map((row) => row.getAttribute('data-target-id'))).toEqual(['u-jakob'])
  })

  test('keeps the words and says the row’s failure when the answer did not go', async () => {
    const marks = client({
      reply: vi.fn(async () => {
        throw new AnnotationRequestError(500, 'INTERNAL', 'boom')
      }),
    })
    render(<InboxItemRow item={markRow()} markClient={marks} />)
    fireEvent.click(screen.getByTestId('inbox-mark-reply'))
    const box = screen.getByLabelText('Your reply to annotation 4')
    await userEvent.type(box, 'Ist bestellt.{Enter}')
    expect(await screen.findByText('That did not work. Nothing has changed.')).toBeInTheDocument()
    expect(box).toHaveValue('Ist bestellt.')
  })

  test('news on a mark only opens it: nothing waits on the reader there', () => {
    render(<InboxItemRow item={markRow({ type: 'annotation.activity', actionable: false, variant: 'reply' })} markClient={client()} />)
    expect(screen.getByTestId('inbox-open-mark')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-mark-reply')).not.toBeInTheDocument()
    expect(screen.queryByTestId('inbox-mark-resolve')).not.toBeInTheDocument()
  })

  test('a resolved or redacted mark row offers no answer', () => {
    const { unmount } = render(<InboxItemRow item={markRow({ state: 'resolved' })} markClient={client()} />)
    expect(screen.queryByTestId('inbox-mark-reply')).not.toBeInTheDocument()
    unmount()
    render(<InboxItemRow item={markRow({ state: 'inert', href: null })} markClient={client()} />)
    expect(screen.queryByTestId('inbox-open-mark')).not.toBeInTheDocument()
    expect(screen.queryByTestId('inbox-mark-reply')).not.toBeInTheDocument()
  })
})

describe('InboxItemRow — who and what at a glance', () => {
  test('a row a person caused wears their face, with the type’s glyph in the corner', () => {
    render(<InboxItemRow item={item()} />)
    expect(screen.getByTestId('person-avatar')).toHaveTextContent('AW')
    expect(screen.getByTestId('inbox-item-type-badge')).toBeInTheDocument()
  })

  test('a system row keeps its glyph, and Piloti’s row keeps Piloti’s face, drawn as a line', () => {
    const { unmount } = render(
      <InboxItemRow item={item({ type: 'storage.quota_warning', actorName: null, actorUserId: null, resourceType: 'organization', href: '/app/organization/storage' })} />,
    )
    expect(screen.queryByTestId('person-avatar')).not.toBeInTheDocument()
    unmount()
    render(<InboxItemRow item={item({ type: 'piloti.work_done', actionable: false, actorName: null, actorUserId: null })} />)
    expect(document.querySelector('[data-slot="piloti-glyph"]')).toHaveAttribute('data-tone', 'outline')
    expect(screen.queryByTestId('person-avatar')).not.toBeInTheDocument()
  })

  test('the line under the title wraps to two lines instead of cutting its sentence', () => {
    render(<InboxItemRow item={item()} />)
    expect(screen.getByText('in Atrium – Rauchabschnitte')).toHaveClass('line-clamp-2', 'whitespace-normal')
  })

  test('a read title steps back in dark mode; an unread one does not', () => {
    const { unmount } = render(<InboxItemRow item={item({ state: 'read' })} />)
    expect(screen.getByTestId('inbox-item-link')).toHaveClass('dark:text-muted-foreground')
    unmount()
    render(<InboxItemRow item={item()} />)
    expect(screen.getByTestId('inbox-item-link')).not.toHaveClass('dark:text-muted-foreground')
  })

  test('the keyboard’s row is marked and ringed', () => {
    render(<InboxItemRow item={item()} focused />)
    const row = screen.getByTestId('inbox-item')
    expect(row).toHaveAttribute('data-focused', 'true')
    expect(row).toHaveClass('ring-2', 'ring-inset')
  })

  test('a filing suggestion says it waits on the file under Dateien, not in a chat', () => {
    renderPlain(
      <I18nProvider initialLocale="de" fixedLocale>
        <InboxItemRow
          item={item({
            type: 'piloti.proposal_waiting',
            actorName: null,
            actorUserId: null,
            resourceType: 'project',
            resourceId: 'p1',
            anchorId: 'prop-1',
            href: '/app/projects/p1/files',
            subject: null,
            excerpt: null,
            variant: 'move',
          })}
        />
      </I18nProvider>,
    )
    expect(
      screen.getByText('Der Vorschlag steht bei der Datei unter Dateien. Übernehmen oder verwerfen Sie ihn dort; bis dahin ändert sich nichts.'),
    ).toBeInTheDocument()
  })
})

describe('InboxItemRow — the row’s menu', () => {
  test('marks an unread row read, and a read row unread', async () => {
    const user = userEvent.setup()
    const onMarkRead = vi.fn()
    const onMarkUnread = vi.fn()
    const { unmount } = render(<InboxItemRow item={item()} onMarkRead={onMarkRead} onMarkUnread={onMarkUnread} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByTestId('inbox-mark-read'))
    expect(onMarkRead).toHaveBeenCalledWith('i1')
    unmount()

    render(<InboxItemRow item={item({ state: 'read' })} onMarkRead={onMarkRead} onMarkUnread={onMarkUnread} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByTestId('inbox-mark-unread'))
    expect(onMarkUnread).toHaveBeenCalledWith('i1')
  })

  test('carries archiving, the only archive control on a phone, where the icon is hidden', async () => {
    const user = userEvent.setup()
    const onArchive = vi.fn()
    render(<InboxItemRow item={item()} onArchive={onArchive} />)
    expect(screen.getByRole('button', { name: 'Archive' })).toHaveClass('max-sm:hidden')
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByTestId('inbox-archive-menu'))
    expect(onArchive).toHaveBeenCalledWith('i1')
  })

  test('an archived row is restored, not archived again', async () => {
    const user = userEvent.setup()
    const onArchive = vi.fn()
    const onUnarchive = vi.fn()
    render(<InboxItemRow item={item({ state: 'archived', archived: true })} onArchive={onArchive} onUnarchive={onUnarchive} />)
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByTestId('inbox-unarchive'))
    expect(onUnarchive).toHaveBeenCalledWith('i1')
    expect(onArchive).not.toHaveBeenCalled()
  })
})

describe('InboxItemRow — an archived row whose target went away', () => {
  test('is restored, never archived again: archived is its own fact, not its state', async () => {
    const user = userEvent.setup()
    const onArchive = vi.fn()
    const onUnarchive = vi.fn()
    render(
      <InboxItemRow
        item={item({ state: 'inert', archived: true, href: null, subject: null, excerpt: null })}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.queryByTestId('inbox-archive-menu')).not.toBeInTheDocument()
    await user.click(await screen.findByTestId('inbox-unarchive'))
    expect(onUnarchive).toHaveBeenCalledWith('i1')
  })
})

describe('InboxItemRow — every way to its target counts as opening it', () => {
  test('„Datei öffnen“ on a review request is a client link that marks the row read', () => {
    const onOpen = vi.fn()
    render(
      <InboxItemRow
        item={item({ type: 'document.review_requested', resourceType: 'document', resourceId: 'doc-7', anchorId: 'ver-7', href: '/app/projects/p1/files?doc=doc-7', subject: 'Befund' })}
        onOpen={onOpen}
        reviewClient={{ approve: vi.fn(), requestChanges: vi.fn(), reject: vi.fn() }}
      />,
    )
    fireEvent.click(screen.getByTestId('inbox-review-open'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test('„Mit Piloti besprechen“ marks the row read, and is an icon with a name on a phone', () => {
    const onOpen = vi.fn()
    render(
      <InboxItemRow
        item={item({ type: 'document.new_revision', actionable: false, resourceType: 'document', resourceId: 'doc-7', anchorId: 'ver-2', href: '/app/projects/p1/files?doc=doc-7', subject: 'Befund', related: null })}
        onOpen={onOpen}
      />,
    )
    const discuss = screen.getByTestId('discuss-document')
    expect(discuss).toHaveAttribute('aria-label', 'Discuss with Piloti')
    expect(discuss.querySelector('.max-sm\\:hidden')).not.toBeNull()
    fireEvent.click(discuss)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
