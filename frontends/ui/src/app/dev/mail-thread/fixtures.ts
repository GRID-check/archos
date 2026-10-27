/**
 * Fixtures of the „E-Mails“ tab and of a Fassung's provenance, typed from the
 * wire (`mail-thread-wire.ts`, `lifecycle-types.ts`), for `/dev/mail-thread`
 * and the component specs: one per state DECISION §9 names for the tab, each
 * built from the same few builders so a change to the wire breaks them at
 * compile time, not on screen.
 *
 * `fixtureMailThreadClient` serves them behind the interface the tab takes
 * (`MailThreadClient`). Following, renewing, ending a follow and detaching
 * „work“ in a preview: the next read answers the changed thread.
 */

import type { ProjectPerson } from '@/adapters/api/folder-access-client'
import type { MailThreadClient } from '@/features/documents/components/mail-thread/client'
import type { FetchedDownload } from '@/lib/browser-download'
import type { DocumentVersionView } from '@/lib/documents/lifecycle-types'
import type { MailOriginView } from '@/lib/inbound-mail/inbound-mail-wire'
import type {
  MailThreadAttachmentView,
  MailThreadEntryView,
  MailThreadFollowView,
  MailThreadSummaryView,
  MailThreadView,
} from '@/lib/mail-thread/mail-thread-wire'
import { ApiRequestError } from '@/adapters/api/api-error'
import { fixtureId } from '../inbound-mail/fixtures'

export const PROJECT_ID = 'p-dev-1'
export const VIEWER_ID = 'user_01JVIEWER00000000000000000'
export const THREAD_DOCUMENT_ID = fixtureId('doc:stellplatz')
export const THREAD_FOLDER_ID = fixtureId('folder:korrespondenz')
/** Now, for every fixture: the times below are hours and days around it. */
export const FIXTURE_NOW = Date.parse('2026-10-22T09:30:00.000Z')

const DAY = 86_400_000
const at = (offsetMs: number): string => new Date(FIXTURE_NOW + offsetMs).toISOString()
const daysAgo = (days: number): string => at(-days * DAY)
const daysAhead = (days: number): string => at(days * DAY)

// ------------------------------------------------------------ builders

export function attachment(overrides: Partial<MailThreadAttachmentView> & { position: number }): MailThreadAttachmentView {
  return { filename: 'Unterlage.pdf', disposition: 'filed', documentId: fixtureId(`doc:att:${overrides.position}`), documentVersionId: fixtureId(`ver:att:${overrides.position}`), visible: true, ...overrides }
}

export function entry(overrides: Partial<MailThreadEntryView> & { key: string; version: number }): MailThreadEntryView {
  const { key, version, ...rest } = overrides
  return {
    id: fixtureId(`entry:${key}`),
    heading: '14.10.2026, 09:12 · Mag. Huber (ma37.wien.gv.at)',
    source: 'inbound',
    senderName: 'Mag. Huber',
    senderDomain: 'ma37.wien.gv.at',
    signerDomain: 'ma37.wien.gv.at',
    senderTrust: 'external_verified',
    sentAt: daysAgo(8),
    receivedAt: daysAgo(8),
    firstVersion: { id: fixtureId(`ver:thread:${version}`), number: version },
    original: { scanStatus: 'clean' },
    attachments: [],
    filedBy: VIEWER_ID,
    filedVia: 'app',
    filedAt: daysAgo(8),
    ...rest,
  }
}

export function follow(overrides: Partial<MailThreadFollowView> & { userId: string }): MailThreadFollowView {
  return {
    id: fixtureId(`follow:${overrides.userId}`),
    createdAt: daysAgo(10),
    expiresAt: daysAhead(50),
    renewedAt: null,
    dailyCap: 20,
    ...overrides,
  }
}

export function thread(overrides: Partial<MailThreadView> = {}): MailThreadView {
  const entries = overrides.entries ?? threeMessages()
  return {
    id: fixtureId('thread:stellplatz'),
    documentId: THREAD_DOCUMENT_ID,
    name: 'Stellplatznachweis',
    entryCount: entries.length,
    lastEntryAt: entries.at(-1)?.sentAt ?? null,
    followed: false,
    participantDomains: ['ma37.wien.gv.at', 'statik-weber.at', 'huber-architektur.at'],
    continuesThreadId: null,
    follows: [],
    managesFollows: false,
    waitingCount: 0,
    ...overrides,
    entries,
  }
}

/** The thread document's Fassungen 1..n, as `document-version-list` answers them. */
export function versions(count: number): DocumentVersionView[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1
    return {
      id: fixtureId(`ver:thread:${number}`),
      documentId: THREAD_DOCUMENT_ID,
      versionNumber: number,
      state: number === count ? 'published' : 'superseded',
      contentType: 'text/markdown',
      fileSize: 2_400 * number,
      contentHash: null,
      submittedBy: null,
      submittedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      approvedBy: null,
      approvedAt: null,
      publishedBy: VIEWER_ID,
      publishedAt: daysAgo(count - number),
      reviewComment: null,
      createdBy: VIEWER_ID,
      createdAt: daysAgo(count - number),
      updatedAt: daysAgo(count - number),
    }
  })
}

function threeMessages(): MailThreadEntryView[] {
  return [
    entry({
      key: 'first',
      version: 1,
      heading: '02.10.2026, 16:40 · Miriam Huber (huber-architektur.at)',
      senderName: 'Miriam Huber',
      senderDomain: 'huber-architektur.at',
      signerDomain: 'huber-architektur.at',
      senderTrust: 'member_verified',
      sentAt: daysAgo(20),
      receivedAt: daysAgo(20),
    }),
    entry({
      key: 'statik',
      version: 2,
      heading: '09.10.2026, 11:05 · DI Petra Weber (statik-weber.at)',
      senderName: 'DI Petra Weber',
      senderDomain: 'statik-weber.at',
      signerDomain: 'statik-weber.at',
      sentAt: daysAgo(13),
      receivedAt: daysAgo(13),
      attachments: [
        attachment({ position: 1, filename: 'S-101_C.pdf', disposition: 'filed' }),
        attachment({ position: 2, filename: 'Lastannahmen.xlsx', disposition: 'already_present' }),
        attachment({ position: 3, filename: 'Rechnung_Okt.zip', disposition: 'not_filed', notFiledReason: 'archive', documentId: undefined, documentVersionId: undefined }),
        attachment({ position: 4, filename: null, disposition: 'filed', visible: false, documentId: undefined, documentVersionId: undefined }),
      ],
    }),
    entry({
      key: 'authority',
      version: 3,
      attachments: [attachment({ position: 1, filename: 'Bescheid_Kopie.pdf' })],
      filedVia: 'piloti_proposal',
    }),
  ]
}

// ------------------------------------------------------------ the variants

export interface MailThreadFixture {
  view: MailThreadView
  versions: DocumentVersionView[]
  /** Other threads of the project, for the detach dialog. */
  others: MailThreadSummaryView[]
  people: ProjectPerson[]
  /** What a download of an original answers. */
  original: FetchedDownload
  /** A detach answers this refusal instead of moving the mail. */
  detachRefusal?: string
  /** The entry the preview opens the detach dialog for, or focuses. */
  detachEntryId?: string
  focusEntryId?: string
  /** The read never answers (`loading`) or fails (`error`). */
  load?: 'loading' | 'error'
}

const OTHERS: MailThreadSummaryView[] = [
  { id: fixtureId('thread:fassade'), documentId: fixtureId('doc:fassade'), name: 'Fassadenmuster Hofseite', entryCount: 4, lastEntryAt: daysAgo(3), followed: false },
  { id: fixtureId('thread:brandschutz'), documentId: fixtureId('doc:brandschutz'), name: 'Brandschutzkonzept – Rückfragen MA 37', entryCount: 2, lastEntryAt: daysAgo(30), followed: true },
]

const PEOPLE: ProjectPerson[] = [
  { userId: VIEWER_ID, name: 'Miriam Huber', email: 'm.huber@huber-architektur.at' },
  { userId: 'user_01JLUKAS000000000000000000', name: 'Lukas Brandstätter', email: 'l.brandstaetter@huber-architektur.at' },
  { userId: 'user_01JSABINE00000000000000000', name: 'Sabine Gruber', email: 's.gruber@huber-architektur.at' },
]

function fixture(overrides: Partial<MailThreadFixture> & { view: MailThreadView }): MailThreadFixture {
  return { versions: versions(Math.max(...overrides.view.entries.map((e) => e.firstVersion?.number ?? 1), 1)), others: OTHERS, people: PEOPLE, original: { saved: true }, ...overrides }
}

function worstCase(): MailThreadView {
  const long = 'Rechtsanwaltskanzlei Dr. Maximiliane Österreicher-Habsburg-Lothringen und Partner:innen'
  const entries: MailThreadEntryView[] = Array.from({ length: 24 }, (_, index) =>
    entry({
      key: `worst-${index}`,
      version: index + 1,
      heading: `${String((index % 28) + 1).padStart(2, '0')}.09.2026, 08:0${index % 10} · ${index % 3 === 0 ? long : index % 3 === 1 ? '李小龍 🏗️' : 'X'} (${index % 2 ? 'sub.domain.with.a.very.long.name.example' : 'a.at'})`,
      senderName: index % 3 === 0 ? long : 'X',
      signerDomain: index % 4 === 0 ? null : 'sub.domain.with.a.very.long.name.example',
      senderTrust: (['external_verified', 'external_unverified', 'member_unverified', 'not_checked'] as const)[index % 4],
      source: index % 4 === 3 ? 'archive' : 'inbound',
      original: index % 4 === 3 ? null : index % 5 === 0 ? { scanStatus: 'infected' } : index % 7 === 0 ? { scanStatus: 'pending' } : { scanStatus: 'clean' },
      filedVia: (['app', 'follow', 'agent', 'archive_import'] as const)[index % 4],
      attachments: index % 2
        ? Array.from({ length: 6 }, (_, position) =>
            attachment({
              position: position + 1,
              filename: position === 0 ? 'Einreichplan_Hofseite_Stellplätze_Variante_3_final_final_wirklich_final_INDEX_C_2026-10-14.pdf' : `Anhang_${position}_ohne_Leerzeichen_sehr_lang_${'x'.repeat(40)}.pdf`,
              disposition: (['filed', 'already_present', 'not_filed'] as const)[position % 3],
              notFiledReason: position % 3 === 2 ? 'type_not_accepted' : undefined,
              visible: position !== 5,
            }),
          )
        : [],
    }),
  )
  return thread({
    name: `Stellplatznachweis – ${long} – Nachreichung zum Bescheid MA 37 vom 14.10.2026`,
    entries,
    followed: true,
    follows: [
      follow({ userId: VIEWER_ID, createdAt: daysAgo(179.5), expiresAt: daysAhead(0.4) }),
      ...Array.from({ length: 9 }, (_, index) => follow({ userId: `user_01JOTHER${index}`, expiresAt: daysAhead(index * 9 + 1) })),
    ],
    managesFollows: true,
    waitingCount: 1_284,
  })
}

export const MAIL_THREAD_VARIANTS: Record<string, MailThreadFixture> = {
  'three-messages': fixture({ view: thread({ waitingCount: 2 }) }),
  // The structural engineer answers three times in a row: „Domain bestätigt: statik-weber.at“ is said once, on the newest.
  'same-sender': fixture({
    view: thread({
      entries: [
        ...threeMessages().slice(0, 2),
        ...[3, 4].map((version) =>
          entry({
            key: `statik-${version}`,
            version,
            heading: `${version === 3 ? '10' : '12'}.10.2026, 08:${version}5 · DI Petra Weber (statik-weber.at)`,
            senderName: 'DI Petra Weber',
            senderDomain: 'statik-weber.at',
            signerDomain: 'statik-weber.at',
            sentAt: daysAgo(15 - version * 2),
            receivedAt: daysAgo(15 - version * 2),
          })
        ),
      ],
    }),
  }),
  followed: fixture({
    view: thread({ followed: true, follows: [follow({ userId: VIEWER_ID })], waitingCount: 0 }),
  }),
  'renew-limit': fixture({
    view: thread({ followed: true, follows: [follow({ userId: VIEWER_ID, createdAt: daysAgo(170), expiresAt: daysAhead(10) })] }),
  }),
  'manager-follows': fixture({
    view: thread({
      followed: true,
      follows: [follow({ userId: VIEWER_ID }), follow({ userId: PEOPLE[1].userId, expiresAt: daysAhead(12) }), follow({ userId: PEOPLE[2].userId, expiresAt: daysAhead(44) })],
      managesFollows: true,
    }),
  }),
  'member-sees-follows': fixture({
    view: thread({ follows: [follow({ userId: PEOPLE[1].userId }), follow({ userId: PEOPLE[2].userId })], managesFollows: false, waitingCount: null }),
  }),
  'unverified-section': fixture({
    view: thread({
      entries: [
        ...threeMessages().slice(0, 2),
        entry({
          key: 'unverified',
          version: 3,
          heading: '15.10.2026, 07:58 · Mag. Huber (ma37-wien.example)',
          senderDomain: 'ma37-wien.example',
          signerDomain: null,
          senderTrust: 'external_unverified',
        }),
      ],
    }),
  }),
  'archive-sections': fixture({
    view: thread({
      entries: threeMessages().map((item) => ({ ...item, source: 'archive', senderTrust: 'not_checked', original: null, filedVia: 'archive_import', signerDomain: null })),
    }),
  }),
  'original-infected': fixture({
    view: thread({ entries: threeMessages().map((item, index) => (index === 2 ? { ...item, original: { scanStatus: 'infected' } } : item)) }),
  }),
  // The entry said clean when it was read; the scan on the download says otherwise (409 `original_not_clean`).
  'original-refused': fixture({ view: thread(), original: { saved: false, status: 409, reason: 'original_not_clean' } }),
  'detach-confirm': fixture({ view: thread({ followed: true, follows: [follow({ userId: VIEWER_ID })] }), detachEntryId: fixtureId('entry:statik') }),
  'detach-refused': fixture({ view: thread(), detachEntryId: fixtureId('entry:statik'), detachRefusal: 'name_taken' }),
  focused: fixture({ view: thread(), focusEntryId: fixtureId('entry:first') }),
  loading: fixture({ view: thread(), load: 'loading' }),
  error: fixture({ view: thread(), load: 'error' }),
  'worst-case': fixture({ view: worstCase(), versions: versions(24) }),
}

// ------------------------------------------------------------ provenance

export function origin(overrides: Partial<MailOriginView> = {}): MailOriginView {
  return {
    threadId: fixtureId('thread:stellplatz'),
    entryId: fixtureId('entry:statik'),
    sentAt: daysAgo(13),
    receivedAt: daysAgo(13),
    fromName: 'DI Petra Weber',
    signerDomain: 'statik-weber.at',
    senderTrust: 'external_verified',
    ...overrides,
  }
}

export const PROVENANCE_ORIGINS: Record<string, MailOriginView[]> = {
  verified: [origin()],
  unverified: [origin({ fromName: 'Mag. Huber', signerDomain: null, senderTrust: 'external_unverified' })],
  archive: [origin({ fromName: 'Statik Weber Büro', signerDomain: null, senderTrust: 'not_checked' })],
  anonymous: [origin({ fromName: null })],
  several: [origin(), origin({ entryId: fixtureId('entry:authority'), fromName: 'Mag. Huber', signerDomain: 'ma37.wien.gv.at' })],
  worst: [
    origin({
      fromName: 'Rechtsanwaltskanzlei Dr. Maximiliane Österreicher-Habsburg-Lothringen und Partner:innen 🏛️',
      signerDomain: 'sub.domain.with.a.very.long.name.that.never.breaks.example',
    }),
    origin(),
    origin(),
  ],
}

// ------------------------------------------------------------ the client

/** The tab's client over one fixture: reads answer it, writes change it, in memory. */
export function fixtureMailThreadClient(fixture: MailThreadFixture): MailThreadClient {
  let view = fixture.view
  const pending = new Promise<never>(() => {})
  const summary = (): MailThreadSummaryView => ({
    id: view.id,
    documentId: view.documentId,
    name: view.name,
    entryCount: view.entries.length,
    lastEntryAt: view.lastEntryAt,
    followed: view.followed,
  })
  return {
    ofDocument: async () => summary(),
    get: async () => {
      if (fixture.load === 'loading') return pending
      if (fixture.load === 'error') throw new ApiRequestError('Failed to load the mail thread', 500)
      return view
    },
    list: async () => ({ items: [summary(), ...fixture.others], nextCursor: null }),
    follow: async () => {
      const own = view.follows.find((item) => item.userId === VIEWER_ID)
      const next = own ? { ...own, expiresAt: daysAhead(60), renewedAt: at(0) } : follow({ userId: VIEWER_ID, createdAt: at(0), expiresAt: daysAhead(60) })
      view = { ...view, followed: true, follows: [...view.follows.filter((item) => item.userId !== VIEWER_ID), next] }
      return { follow: next, renewed: own !== undefined }
    },
    unfollow: async (_projectId, _threadId, options = {}) => {
      const userId = options.userId ?? VIEWER_ID
      const ended = view.follows.find((item) => item.userId === userId) ?? null
      view = { ...view, followed: userId === VIEWER_ID ? false : view.followed, follows: view.follows.filter((item) => item.userId !== userId) }
      return { endedFollowId: ended?.id ?? null }
    },
    detach: async (_projectId, threadId, entryId, body) => {
      if (fixture.detachRefusal) throw new ApiRequestError('Refused', 409, fixture.detachRefusal)
      const followsEnded = view.follows.length
      view = { ...view, entries: view.entries.filter((item) => item.id !== entryId), follows: [], followed: false }
      const to = body.target.action === 'append' ? body.target.mailThreadId : fixtureId('thread:new')
      return {
        entryId,
        from: { threadId, documentId: view.documentId, versionId: fixtureId('ver:after-detach') },
        to: { threadId: to, documentId: fixtureId(`doc:${to}`), versionId: fixtureId('ver:joined') },
        followsEnded,
      }
    },
    downloadOriginal: async () => fixture.original,
    versions: async () => ({ documentId: view.documentId, lifecycle: 'active', publishedVersionId: fixture.versions.at(-1)?.id ?? null, versions: fixture.versions }),
    diff: async (_documentId, from, to) => {
      const version = (id: string): DocumentVersionView => fixture.versions.find((item) => item.id === id) ?? fixture.versions[0]
      return {
        from: { version: version(from), content: '## 02.10.2026, 16:40 · Miriam Huber\n\nKönnen Sie uns die Statik schicken?\n\n## 09.10.2026, 11:05 · DI Petra Weber\n\nAnbei S-101 Index C.' },
        to: {
          version: version(to),
          content:
            '## 02.10.2026, 16:40 · Miriam Huber\n\nKönnen Sie uns die Statik schicken?\n\n## 09.10.2026, 11:05 · DI Petra Weber\n\nAnbei S-101 Index C.\n\n## 14.10.2026, 09:12 · Mag. Huber\n\nDer Stellplatznachweis ist vollständig.',
        },
      }
    },
    people: async () => fixture.people,
  }
}
