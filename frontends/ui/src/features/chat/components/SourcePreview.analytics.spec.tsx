import { render, screen, waitFor } from '@/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { buildCitationModel, type CitationRef } from '../lib/citations'
import type { CitationSource } from '../types'
import { SourceDocumentDialog } from './source-preview/source-document-dialog'
import { capturePosthog } from '@/lib/analytics/posthog'

vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: vi.fn() }))

vi.mock('../store', () => ({
  useChatStore: (
    selector: (s: { projectId: string | null; currentConversation: { id: string } | null }) => unknown
  ) => selector({ projectId: 'project-1', currentConversation: { id: 'conv-1' } }),
}))

vi.mock('@/features/knowledge/components/ris-document-dialog', () => ({
  RisDocumentDialog: ({ title }: { title: string }) => <div data-testid="ris-dialog">{title}</div>,
}))

const ref = (overrides: Partial<CitationSource>, locusKeySuffix = ''): CitationRef => {
  const [document] = buildCitationModel({
    citations: [
      { id: 'c-1', url: '', content: '', timestamp: new Date('2026-07-17T10:00:00Z'), ...overrides },
    ],
  })
  if (!document) throw new Error('fixture produced no document')
  const locus = document.loci[0]
  return { document, locus: locus && locusKeySuffix ? { ...locus, key: `${locus.key}${locusKeySuffix}` } : locus }
}

/**
 * `citation_opened` is the step from an answer to its evidence: counted when
 * the viewer is actually showing, as an enum and a flag, never a name.
 */
describe('SourceDocumentDialog analytics', () => {
  beforeEach(() => {
    vi.mocked(capturePosthog).mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
  })

  test('reports a RIS source opened, with its kind and the viewer, once', async () => {
    const view = ref({
      url: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10010207',
      title: 'Bauordnung',
      content: 'Bauordnung',
      origin: 'ris',
      kind: 'building_law',
    })
    const { rerender } = render(<SourceDocumentDialog citation={view} onClose={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('ris-dialog')).toBeInTheDocument())
    expect(capturePosthog).toHaveBeenCalledTimes(1)
    expect(capturePosthog).toHaveBeenCalledWith('citation_opened', {
      source_kind: 'building_law',
      verified: false,
      viewer: 'ris',
    })

    rerender(<SourceDocumentDialog citation={view} onClose={() => {}} />)
    expect(capturePosthog).toHaveBeenCalledTimes(1)
  })

  test('marks a quote the server verified word for word', async () => {
    const view = ref(
      {
        url: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10010207',
        title: 'Bauordnung',
        content: 'Bauordnung',
        origin: 'ris',
        kind: 'building_law',
      },
      '#quote'
    )
    render(<SourceDocumentDialog citation={view} onClose={() => {}} />)
    await waitFor(() => expect(capturePosthog).toHaveBeenCalled())
    expect(capturePosthog).toHaveBeenCalledWith('citation_opened', expect.objectContaining({ verified: true }))
  })

  test('carries no title, url or file name', async () => {
    const view = ref({
      url: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10010207',
      title: 'Bauordnung',
      content: 'Bauordnung',
      origin: 'ris',
      kind: 'building_law',
    })
    render(<SourceDocumentDialog citation={view} onClose={() => {}} />)
    await waitFor(() => expect(capturePosthog).toHaveBeenCalled())
    expect(JSON.stringify(vi.mocked(capturePosthog).mock.calls)).not.toMatch(/Bauordnung|ris\.bka|http/)
  })
})
