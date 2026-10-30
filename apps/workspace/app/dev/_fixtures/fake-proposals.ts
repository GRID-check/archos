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
  /** An action of the agent catalog with a long value: „Übernehmen“ waits until it is read in full. */
  operationOpen: id(10),
  operationIds: id(11),
  /** A change to a filed Skizze, open: the server's picture of it and the steps. */
  sketchEditOpen: id(12),
  /** The same kind of change, applied: „Rückgängig“ while its Fassung is current. */
  sketchEditApplied: id(13),
} as const

/** The Skizze the sketch-edit demos change, and the Fassung an applied one made. */
const SKETCH = { documentId: 'doc-sketch-demo', base: 'ver-sketch-1', made: 'ver-sketch-2' }

const SKETCH_EDIT_INPUT = {
  params: { id: SKETCH.documentId },
  body: {
    baseVersionId: SKETCH.base,
    ops: [
      { op: 'add', intent: 'Bad rechts neben den Flur', element: { type: 'rectangle', id: 'bath', x: 0, y: 0, label: { text: 'Bad' } } },
      { op: 'place', intent: 'Bad 40 px rechts vom Flur', id: 'bath', referenceId: 'hall', side: 'right' },
      { op: 'remove', intent: 'Abstellraum entfällt, mit seinem Pfeil', id: 'store' },
      { op: 'update', intent: 'Küche heißt jetzt Kochen', id: 'kitchen', set: { label: { text: 'Kochen' } } },
    ],
  },
}

/** What the server's renderer draws for that edit, drawn by hand: `/dev` has no renderer. */
const SKETCH_EDIT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 220" width="520" height="220">
<rect width="520" height="220" fill="#fff"/>
<g fill="none" stroke-width="2" font-family="Helvetica, Arial, sans-serif" font-size="16" text-anchor="middle">
<rect x="20" y="20" width="160" height="80" rx="8" stroke="#1e1e1e" opacity="0.3"/><text x="100" y="65" fill="#1e1e1e" stroke="none" opacity="0.3">Flur</text>
<rect x="220" y="20" width="160" height="80" rx="8" stroke="#2f9e44"/><text x="300" y="65" fill="#2f9e44" stroke="none">Bad</text>
<rect x="20" y="130" width="160" height="70" rx="8" stroke="#868e96" stroke-dasharray="8 6" opacity="0.6"/>
<rect x="20" y="130" width="160" height="70" rx="8" stroke="#1971c2"/><text x="100" y="170" fill="#1971c2" stroke="none">Kochen</text>
<rect x="340" y="130" width="160" height="70" rx="8" stroke="#e03131" stroke-dasharray="8 6" opacity="0.8"/><text x="420" y="170" fill="#e03131" stroke="none" opacity="0.8">Abstellraum</text>
<path d="M180 165 L340 165" stroke="#e03131" stroke-dasharray="8 6" opacity="0.8"/>
</g></svg>`

/** The ids an operation names, for the card that shows each by its name (and one this reader may not read). */
const NAMED = {
  folder: '0b7a9c1e-2d3f-4a5b-8c6d-7e8f9a0b1c2d',
  documents: ['3c2b1a0f-9e8d-4c7b-a6f5-4e3d2c1b0a9f', '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'],
  person: 'user_anna',
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

/** Office instructions with a long text: the card shows the start until the reader unfolds it. */
const OPERATION = {
  operation: 'organization-instructions-set',
  input: {
    body: {
      instructions:
        'Antworte knapp und auf Deutsch. Nenne bei jeder Aussage zum Baurecht die Fundstelle. ' +
        'Bei Brandschutzfragen gilt die OIB-Richtlinie 2 in der Fassung 2023; weiche nur ab, wenn das Projekt es verlangt, ' +
        'und sag dann, warum. Frag nach, bevor du eine Gebäudeklasse annimmst.',
      tone: 'sachlich',
      limits: { words: 200, sources: ['norm', 'office'] },
    },
  },
  summary: 'Set the office instructions (instructions: Antworte knapp und auf Deutsch. Nenne bei jeder…, tone: sachlich, limits: 2 fields)',
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
        {
          ...base,
          id: DEMO.operationOpen,
          kind: 'operation',
          payload: OPERATION,
          targets: [{ type: 'project', id: DEMO_PROJECT_ID, name: 'Wohnanlage Lindengasse' }],
        },
        {
          ...base,
          id: DEMO.operationIds,
          kind: 'operation',
          payload: {
            operation: 'document-move',
            input: {
              params: { id: DEMO_PROJECT_ID },
              body: { folderId: NAMED.folder, documentIds: [...NAMED.documents], assigneeId: NAMED.person },
            },
            summary: 'Zwei Dokumente nach „Einreichung“ verschieben und Anna zuweisen',
          },
          targets: [
            { type: 'project', id: DEMO_PROJECT_ID, name: 'Wohnanlage Lindengasse' },
            { type: 'folder', id: NAMED.folder, name: 'Einreichung' },
            { type: 'document', id: NAMED.documents[0], name: 'Baubeschreibung.pdf' },
            { type: 'document', id: NAMED.documents[1], name: null },
            { type: 'member', id: NAMED.person, name: 'Anna Berger' },
          ],
        },
        {
          ...base,
          id: DEMO.sketchEditOpen,
          kind: 'operation',
          payload: { operation: 'document-sketch-edit', input: SKETCH_EDIT_INPUT, summary: 'Skizze „Raumprogramm EG“ ändern: vier Schritte' },
          targets: [{ type: 'document', id: SKETCH.documentId, name: 'Raumprogramm EG.svg' }],
        },
        {
          ...base,
          id: DEMO.sketchEditApplied,
          kind: 'operation',
          status: 'applied',
          canDecide: false,
          decidedBy: 'user_anna',
          decidedByName: 'Anna Berger',
          decidedAt: '2026-10-30T09:12:00.000Z',
          results: [{ label: 'Skizze „Raumprogramm EG“ ändern', ok: true, itemId: SKETCH.made }],
          payload: { operation: 'document-sketch-edit', input: SKETCH_EDIT_INPUT, summary: 'Skizze „Raumprogramm EG“ ändern: vier Schritte' },
        },
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

/** The one result line of a memory note, a profile change or an operation. */
function labelOf(proposal: Exclude<ProposedChangeView, { kind: 'file_operation' }>): string {
  switch (proposal.kind) {
    case 'memory':
      return proposal.payload.content
    case 'operation':
      return proposal.payload.summary
    case 'project_profile':
      return proposal.payload.title
  }
}

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
          : current.kind === 'operation' && current.payload.operation === 'document-sketch-edit'
            ? [{ label: labelOf(current), ok: true, itemId: SKETCH.made }]
            : [{ label: labelOf(current), ok: true }]
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
    const sketch = `/api/documents/${SKETCH.documentId}/sketch`
    if (url.pathname === `${sketch}/edits/preview`) {
      const diff = { added: ['bath'], removed: ['store'], changed: ['kitchen'] }
      return json({ documentId: SKETCH.documentId, baseVersionId: SKETCH.base, diff, warnings: [], svg: SKETCH_EDIT_SVG })
    }
    if (url.pathname === sketch) return json({ hasScene: true, canWrite: true, versionId: SKETCH.made })
    if (url.pathname === `${sketch}/revert`) return json({ documentId: SKETCH.documentId, versionId: 'ver-sketch-3', versionNumber: 3 })
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
