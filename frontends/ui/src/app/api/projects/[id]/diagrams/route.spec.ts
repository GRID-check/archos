/**
 * @vitest-environment node
 */
/**
 * What this route reads before it agrees to do any work.
 *
 * The filing service and the SVG validator have their own specs; what is only
 * testable here is the TRANSPORT. `parseDiagramSvg` caps an SVG at 1 MiB and
 * `acceptDiagram` caps a source per kind — but both run after `request.json()`
 * has buffered the whole body, and an App Router handler has no body limit of
 * its own (`next.config`'s `bodySizeLimit` governs Server Actions only). So the
 * caps `docs/api/bff-routes.md` advertises were, until these tests, enforced on
 * a payload the process had already taken in.
 *
 * The other half is the partial filing: `fileDiagramDocuments` answers with
 * `pdf: null` when only the SVG landed, and this is where the promise that such
 * an answer is a 201 rather than a 500 is kept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    organizationMembershipId: 'om-1',
    email: 'architektin@example.at',
    role: 'editor',
    permissions: ['project:documents:write'],
  }),
}))

vi.mock('@/i18n/server', () => ({ getLocale: vi.fn().mockResolvedValue('de') }))

const fileDiagramDocuments = vi.fn()
vi.mock('@/lib/diagrams/filing', () => ({
  fileDiagramDocuments: (...args: unknown[]) => fileDiagramDocuments(...args),
}))

const recordDiagramScore = vi.fn()
vi.mock('@/lib/langfuse/diagram-score', () => ({
  recordDiagramScore: (...args: unknown[]) => recordDiagramScore(...args),
}))

const requireResourceAccess = vi.fn()
vi.mock('@/lib/sharing/access', () => ({
  requireResourceAccess: (...args: unknown[]) => requireResourceAccess(...args),
}))

import { createInProcessStore, setLimitStore } from '@/lib/limits'
import { MAX_DIAGRAM_SVG_BYTES } from '@/lib/diagrams/diagram-sources'
import { DiagramSvgError } from '@/lib/diagrams/svg'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { errorsCopy } from '@/i18n/namespaces/errors'
import { POST } from './route'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

const filed = (documentId: string) => ({
  documentId,
  filename: `${documentId}.bin`,
  folderId: 'folder-1',
  alreadyFiled: false,
})

const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  POST(
    new NextRequest('https://grid.test/api/projects/proj-1/diagrams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'proj-1' }) }
  )

const submission = (overrides: Record<string, unknown> = {}) => ({
  runId: 'msg_42-1a2b3c4d',
  title: 'Ablauf Einreichung',
  sourceKind: 'mermaid',
  source: 'graph TD\n  A --> B',
  svg: SVG,
  ...overrides,
})

beforeEach(() => {
  setLimitStore(createInProcessStore())
  fileDiagramDocuments.mockReset().mockResolvedValue({ svg: filed('doc-svg'), pdf: filed('doc-pdf') })
})

afterEach(() => {
  setLimitStore(null)
})

describe('POST /api/projects/[id]/diagrams', () => {
  it('files a diagram and answers with both halves', async () => {
    const response = await post(submission())

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      svg: { documentId: 'doc-svg' },
      pdf: { documentId: 'doc-pdf' },
    })
  })

  it('marks a drawing a person edited as having two authors, and scores it on the answer’s trace (ADR-0141)', async () => {
    recordDiagramScore.mockReset()
    const response = await post(
      submission({ sourceKind: 'excalidraw', source: '{"type":"excalidraw"}', edited: true, answerId: 'msg_42' })
    )

    expect(response.status).toBe(201)
    expect(fileDiagramDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: 'excalidraw', marking: diagramsCopy.messages.de.markingEdited })
    )
    expect(recordDiagramScore).toHaveBeenCalledWith({
      organizationId: 'org-1',
      answerId: 'msg_42',
      documentId: 'doc-svg',
      edited: true,
    })
  })

  it('keeps „Von Piloti erstellt" on a drawing filed as drawn', async () => {
    recordDiagramScore.mockReset()
    await post(submission())
    expect(fileDiagramDocuments).toHaveBeenCalledWith(expect.objectContaining({ marking: diagramsCopy.messages.de.marking }))
    expect(recordDiagramScore).toHaveBeenCalledWith(expect.objectContaining({ answerId: null, edited: false }))
  })

  it('marks a sketch Piloti drew, filed as drawn, as not to scale', async () => {
    await post(submission({ sourceKind: 'excalidraw', source: '{"type":"excalidraw","elements":[]}' }))
    expect(fileDiagramDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: 'excalidraw', marking: diagramsCopy.messages.de.markingSketch })
    )
  })

  it('names the refused rule in the reader’s language', async () => {
    // The message is the only debugging surface a browser has, and the depth
    // rule is the newest member of the tuple it is keyed by.
    fileDiagramDocuments.mockRejectedValue(new DiagramSvgError('too-deep', 'nested deeper than 64'))

    const response = await post(submission())

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: diagramsCopy.messages.de.rejected['too-deep'] })
  })
})

describe('a partial filing is an answer, not a failure', () => {
  it('answers 201 with a null PDF when only the SVG landed', async () => {
    // The SVG is filed, quota-charged and visible in Berichte. Any 4xx/5xx here
    // would be a false statement about the project — and it was the statement
    // this route made: `FiledDiagram` required both halves, so a PDF failure
    // threw and the reader was told „Internal server error" about a file that
    // exists.
    fileDiagramDocuments.mockResolvedValue({ svg: filed('doc-svg'), pdf: null })

    const response = await post(submission())

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ svg: { documentId: 'doc-svg' }, pdf: null })
  })
})

describe('the body bounds', () => {
  it('refuses an SVG past the cap without handing it to the filer', async () => {
    // The cap existed; what did not exist was anything applying it before the
    // body was read and the validator was entered.
    const response = await post(submission({ svg: `${SVG}${'x'.repeat(MAX_DIAGRAM_SVG_BYTES)}` }))

    expect(response.status).toBe(400)
    expect(fileDiagramDocuments).not.toHaveBeenCalled()
  })

  it('refuses a source past the largest kind’s cap', async () => {
    // The per-kind cap (32 KiB mermaid) still belongs to `acceptDiagram`, which
    // knows the kind; this one only keeps an unbounded string out of it.
    const response = await post(submission({ source: 'x'.repeat(512 * 1024 + 1) }))

    expect(response.status).toBe(400)
    expect(fileDiagramDocuments).not.toHaveBeenCalled()
  })

  it('accepts a source the largest kind allows, so the bound is not a ban', async () => {
    // The pair is the test: the refusal above also passes with the bound set to
    // one byte. `excalidraw` declares 512 KiB, and a bound below its own cap
    // would refuse legitimate scenes at the transport before the kind is read.
    const response = await post(submission({ sourceKind: 'excalidraw', source: 'x'.repeat(512 * 1024) }))

    expect(response.status).toBe(201)
  })

  it('refuses a body that declares itself too large, before reading it', async () => {
    const response = await post(submission(), { 'content-length': String(64 * 1024 * 1024) })

    expect(response.status).toBe(413)
    expect(fileDiagramDocuments).not.toHaveBeenCalled()
  })
})

describe('a diagram from a conversation (ADR-0087)', () => {
  it('authorizes the conversation and hands it to the filer, which refuses an open folder for a confined one', async () => {
    requireResourceAccess.mockReset().mockResolvedValue({})
    const response = await post(submission({ conversationId: 's_conv_1' }))

    expect(response.status).toBe(201)
    expect(requireResourceAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'conversation',
      's_conv_1',
      'viewer'
    )
    expect(fileDiagramDocuments.mock.calls[0][0]).toMatchObject({
      origin: { conversationId: 's_conv_1', locale: 'de' },
    })
  })

  it('relays the refusal as a typed 403 with the reader’s sentence', async () => {
    requireResourceAccess.mockReset().mockResolvedValue({})
    const { ConversationConfinedError } = await import('@/lib/api/errors')
    fileDiagramDocuments.mockRejectedValueOnce(new ConversationConfinedError('filing', errorsCopy.messages.de.confinement.filing))

    const response = await post(submission({ conversationId: 's_conv_1' }))

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: 'CONVERSATION_CONFINED',
      error: errorsCopy.messages.de.confinement.filing,
    })
  })

  it('files a diagram from a surface that names no conversation without an origin', async () => {
    requireResourceAccess.mockReset()
    await post(submission())
    expect(requireResourceAccess).not.toHaveBeenCalled()
    expect(fileDiagramDocuments.mock.calls[0][0].origin).toBeUndefined()
  })
})
