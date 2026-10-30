/**
 * The receipt of a Skizze edit (`document-sketch-edit`, S4): the server's
 * picture of the change with its legend, the intents as steps, the decision in
 * the shared frame, and „Rückgängig“ while the edit's Fassung is current.
 *
 * Rendered without an `I18nProvider`, so the dictionary falls back to `en`.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/mocks/server'
import type { ProposedChangeView } from '@/lib/proposals/types'
import { resetDecidedProposals } from '../decided-proposals'
import { SketchEditReceipt } from './SketchEditReceipt'
import { decidedByAnna, PROPOSAL_ID, proposalBase, requests, resetKit, serve, startRecording } from './proposal-test-kit'

type OperationProposal = Extract<ProposedChangeView, { kind: 'operation' }>

const INPUT = {
  params: { id: 'doc-1' },
  body: {
    baseVersionId: 'ver-1',
    ops: [
      { op: 'add', intent: 'Bad neben den Flur', element: { type: 'rectangle', id: 'bath', x: 0, y: 0, label: { text: 'Bad' } } },
      { op: 'remove', intent: 'Abstellraum entfernen', id: 'store' },
    ],
  },
}

const proposal = (patch: Partial<OperationProposal> = {}): OperationProposal => ({
  ...proposalBase(),
  kind: 'operation',
  payload: { operation: 'document-sketch-edit', input: INPUT, summary: 'Change a sketch by operations (baseVersionId: ver-1, ops: 2 items)' },
  ...patch,
})

const card = <SketchEditReceipt proposalId={PROPOSAL_ID} title="Change the sketch" input={INPUT} />
const posts = () => requests.filter((line) => line.startsWith('POST'))

beforeEach(() => {
  startRecording()
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => undefined }))
  server.use(
    http.post('/api/documents/doc-1/sketch/edits/preview', () =>
      HttpResponse.json({ documentId: 'doc-1', baseVersionId: 'ver-1', diff: { added: ['bath'], removed: ['store'], changed: [] }, warnings: [], svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    )
  )
})

afterEach(() => {
  resetKit()
  resetDecidedProposals()
})

describe('a sketch edit receipt', () => {
  it('shows the server’s picture of the change with its legend, the steps, and the decision', async () => {
    serve(proposal())
    render(card)
    expect(await screen.findByTestId('sketch-edit-preview')).toHaveAttribute('src', 'blob:preview')
    expect(screen.getByTestId('sketch-edit-legend')).toHaveTextContent('newremovedchanged')
    expect(Array.from(screen.getByTestId('sketch-edit-steps').querySelectorAll('li')).map((step) => step.textContent)).toEqual([
      'Bad neben den Flur',
      'Abstellraum entfernen',
    ])
    expect(await screen.findByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(posts()).toEqual(['POST /api/documents/doc-1/sketch/edits/preview'])
  })

  it('offers Undo on an applied edit while its Fassung is current, and takes it back', async () => {
    serve(proposal(decidedByAnna('applied', [{ label: 'Change', ok: true, itemId: 'ver-2' }])))
    server.use(
      http.get('/api/documents/doc-1/sketch', () => HttpResponse.json({ hasScene: true, canWrite: true, versionId: 'ver-2' })),
      http.post('/api/documents/doc-1/sketch/revert', () => HttpResponse.json({ documentId: 'doc-1', versionId: 'ver-3', versionNumber: 3 }))
    )
    render(card)
    const undo = await screen.findByTestId('sketch-edit-undo')
    await waitFor(() => expect(undo).not.toHaveAttribute('aria-disabled'))
    await userEvent.click(undo)
    expect(await screen.findByTestId('sketch-edit-undone')).toBeInTheDocument()
    expect(posts()).toContain('POST /api/documents/doc-1/sketch/revert')
    // A decided card draws no preview.
    expect(posts()).not.toContain('POST /api/documents/doc-1/sketch/edits/preview')
  })

  it('holds Undo back, with the reason, once a newer Fassung exists', async () => {
    serve(proposal(decidedByAnna('applied', [{ label: 'Change', ok: true, itemId: 'ver-2' }])))
    server.use(http.get('/api/documents/doc-1/sketch', () => HttpResponse.json({ hasScene: true, canWrite: true, versionId: 'ver-4' })))
    render(card)
    expect(await screen.findByTestId('sketch-edit-undo-note')).toHaveTextContent('A newer version of the sketch exists since')
    await userEvent.click(screen.getByTestId('sketch-edit-undo'))
    expect(posts()).not.toContain('POST /api/documents/doc-1/sketch/revert')
  })
})
