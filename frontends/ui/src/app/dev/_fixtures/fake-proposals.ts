'use client'

/**
 * A faked proposals API for the `/dev` previews of the proposal receipts.
 *
 * `/dev` has no backend, and a receipt that finds no `GET /api/proposals/<id>`
 * draws its failure state, which is not the state under review. This answers the
 * three person routes (`GET …/[id]`, `POST …/apply`, `POST …/dismiss`) and the
 * project profile read from memory, with the real response shape
 * (`proposalResponseSchema` parses it), so a click on a preview moves the
 * proposal exactly as the server would: applied, with a result per item, and
 * who decided it. Every other request goes to the real `fetch`.
 *
 * Previews only; installed by the page that shows a receipt, removed with it.
 */

import { useEffect, useState } from 'react'
import type { ProjectProfile } from '@/lib/project-profile/types'
import type { ListedProposal, ProposedChangeResult, ProposedChangeView } from '@/lib/proposals/types'

const id = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`

export const DEMO_PROJECT_ID = 'proj-demo'

const FILE_ITEMS = [
  { document: 'Grundriss EG.pdf', source: 'project' as const, current: 'Nachweise', target_folder: 'Einreichung/Pläne' },
  { document: 'Grundriss OG.pdf', source: 'project' as const, current: '', target_folder: 'Einreichung/Pläne' },
  {
    document: 'Schnitt A-A – Bestand und Neubau (Revision 3).pdf',
    source: 'project' as const,
    current: 'Nachweise',
    target_folder: 'Einreichung/Pläne',
  },
]

const PROFILE_PATCH = [
  { op: 'add' as const, path: '/facts/heat_supply', value: 'heat_pump' },
  { op: 'add' as const, path: '/facts/escape_level_m', value: 25 },
]

/** The proposals a preview may show, by the id a card carries. */
export const DEMO = {
  /** Open, this reader may decide: a batch of three moves. */
  filesOpen: id(1),
  /** Applied by a colleague, one row failed. */
  filesPartial: id(2),
  /** Open, but this reader may only read. */
  filesReadOnly: id(3),
  /** An office note, open. */
  memoryOpen: id(4),
  /** An office note that corrects an earlier one. */
  memoryCorrection: id(5),
  /** Remembered by a colleague. */
  memoryDecided: id(6),
  /** A change to the project facts, open. */
  profileOpen: id(7),
  /** The same change, applied by a colleague. */
  profileDecided: id(8),
  /** Discarded by a colleague. */
  profileDismissed: id(9),
} as const

const base = {
  projectId: DEMO_PROJECT_ID,
  status: 'proposed' as const,
  proposedByKind: 'piloti' as const,
  onBehalfOf: 'user_me',
  onBehalfOfName: 'Mia Huber',
  originConversationId: null,
  originMessageId: null,
  createdAt: '2026-10-13T08:00:00.000Z',
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  results: null,
  canDecide: true,
}

const byAnna = (status: 'applied' | 'partially_applied' | 'dismissed', results: ProposedChangeResult[] | null) => ({
  status,
  results,
  decidedBy: 'user_anna',
  decidedByName: 'Anna Berger',
  decidedAt: '2026-10-13T14:02:00.000Z',
  canDecide: false,
})

const MEMORY = {
  scope: 'organization' as const,
  kind: 'preference' as const,
  content: 'Das Büro setzt bei GK 4 durchgängig REI 90 an, auch wo REI 60 genügen würde.',
  confidence: 'high' as const,
  supersedes: null,
}

const PROFILE = {
  title: 'Projektkontext aktualisieren: Wärmeversorgung und Fluchtniveau',
  rationale: 'Sie haben im Gespräch eine Wärmepumpe und ein oberstes Fluchtniveau von 25 m genannt.',
  patch: PROFILE_PATCH,
}

const seed = (): Map<string, ProposedChangeView> =>
  new Map<string, ProposedChangeView>(
    (
      [
        { ...base, id: DEMO.filesOpen, kind: 'file_operation', payload: { operation: 'move', operations: FILE_ITEMS, note: null } },
        {
          ...base,
          ...byAnna('partially_applied', [
            { label: FILE_ITEMS[0].document, ok: true },
            { label: FILE_ITEMS[1].document, ok: true },
            { label: FILE_ITEMS[2].document, ok: false, reason: '„Schnitt A-A – Bestand und Neubau (Revision 3).pdf“ wurde nicht gefunden' },
          ]),
          id: DEMO.filesPartial,
          kind: 'file_operation',
          payload: { operation: 'move', operations: FILE_ITEMS, note: null },
        },
        {
          ...base,
          canDecide: false,
          id: DEMO.filesReadOnly,
          kind: 'file_operation',
          payload: { operation: 'move', operations: FILE_ITEMS.slice(0, 2), note: null },
        },
        { ...base, id: DEMO.memoryOpen, kind: 'memory', payload: MEMORY },
        {
          ...base,
          id: DEMO.memoryCorrection,
          kind: 'memory',
          payload: { ...MEMORY, supersedes: 'Das Büro setzt bei GK 4 REI 60 an.' },
        },
        {
          ...base,
          ...byAnna('applied', [{ label: MEMORY.content, ok: true, itemId: 'memory-1' }]),
          id: DEMO.memoryDecided,
          kind: 'memory',
          payload: MEMORY,
        },
        { ...base, id: DEMO.profileOpen, kind: 'project_profile', payload: PROFILE },
        {
          ...base,
          ...byAnna('applied', [{ label: PROFILE.title, ok: true }]),
          id: DEMO.profileDecided,
          kind: 'project_profile',
          payload: PROFILE,
        },
        { ...base, ...byAnna('dismissed', null), id: DEMO.profileDismissed, kind: 'project_profile', payload: PROFILE },
      ] satisfies ProposedChangeView[]
    ).map((proposal) => [proposal.id, proposal])
  )

/** The profile the demo project has, so „vorher“ differs from „nachher“. */
const PROFILE_NOW: ProjectProfile = {
  facts: {
    heat_supply: { value: 'gas', confidence: 'confirmed', source: 'onboarding', updatedAt: '2026-01-01T00:00:00.000Z' },
    escape_level_m: { value: 11, confidence: 'confirmed', source: 'onboarding', updatedAt: '2026-01-01T00:00:00.000Z' },
  },
  goals: {},
  unknowns: [],
  assumptions: {},
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * Replace `fetch` with the faked API; the returned function puts the real one
 * back. `listed` are proposals a preview brings of its own, with the documents
 * they name (the setup page's filing suggestions): answered like the built-in
 * ones, and by the open-proposals list (`GET /api/proposals`).
 */
export function installFakeProposalClient(listed: readonly ListedProposal[] = []): () => void {
  const real = window.fetch
  const proposals = seed()
  const documentsOf = new Map(listed.map((entry) => [entry.proposal.id, entry.documents]))
  for (const { proposal } of listed) proposals.set(proposal.id, proposal)

  const decide = (current: ProposedChangeView, status: 'applied' | 'dismissed'): ProposedChangeView => {
    const results: ProposedChangeResult[] | null =
      status === 'dismissed'
        ? null
        : current.kind === 'file_operation'
          ? current.payload.operations.map((item) => ({ label: item.document ?? item.folder_name ?? '', ok: true }))
          : [{ label: current.kind === 'memory' ? current.payload.content : current.payload.title, ok: true }]
    return {
      ...current,
      status,
      results,
      decidedBy: 'user_me',
      decidedByName: 'Mia Huber',
      decidedAt: new Date().toISOString(),
      canDecide: false,
    }
  }

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href)
    if (url.pathname === '/api/proposals' && (init?.method ?? 'GET') === 'GET') {
      const open = [...proposals.values()].flatMap((proposal) => {
        const documents = documentsOf.get(proposal.id)
        return documents && proposal.status === 'proposed' && proposal.projectId === url.searchParams.get('projectId')
          ? [{ proposal, documents }]
          : []
      })
      return json({ proposals: open })
    }
    const match = url.pathname.match(/^\/api\/proposals\/([^/]+)(?:\/(apply|dismiss))?$/)
    if (match) {
      const current = proposals.get(match[1])
      if (!current) return json({ error: 'Not found', code: 'NOT_FOUND' }, 404)
      const action = match[2]
      if (!action) return json({ proposal: current })
      if (current.status !== 'proposed') return json({ error: 'Already decided', code: 'CONFLICT' }, 409)
      const next = decide(current, action === 'apply' ? 'applied' : 'dismissed')
      proposals.set(next.id, next)
      return json({ proposal: next })
    }
    if (url.pathname === `/api/projects/${DEMO_PROJECT_ID}/profile`) return json({ profile: PROFILE_NOW, profileVersion: 1 })
    return real(input, init)
  }
  return () => {
    window.fetch = real
  }
}

/**
 * Install the faked API for the life of the page; true once it is in place, so
 * no card asks the real one first. `listed` must be a stable array.
 */
export function useFakeProposalClient(listed?: readonly ListedProposal[]): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const restore = installFakeProposalClient(listed)
    setReady(true)
    return () => {
      restore()
      setReady(false)
    }
  }, [listed])
  return ready
}
