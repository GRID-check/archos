import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { deriveDocumentFindings, referencedBy, resolveReferences, toFindingsDocument } from '@/lib/documents/findings'
import type { FileItem } from '../file-types'
import { DocumentDossier } from './document-dossier'
import { DocumentFindingsList } from './document-findings-panel'

const file = (id: string, filename: string, overrides: Partial<FileItem> = {}): FileItem => ({
  id,
  filename,
  displayName: null,
  fileSize: 1024,
  contentType: 'application/pdf',
  status: 'completed',
  folderId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
  ...overrides,
})

const description = file('desc', 'Baubeschreibung.pdf', {
  dossier: {
    documentType: 'building_description',
    title: null,
    summary: null,
    parties: [{ role: 'architect', name: 'Atelier Lindner Architektur ZT GmbH' }],
    dates: [{ kind: 'issued', date: '2025-03-14' }],
    place: { address: 'Hubergasse 14', municipality: 'Wien' },
    facts: [{ key: 'gross_floor_area', value: '1.245,5', unit: 'm²', page: 3, quote: 'BGF 1.245,5 m²' }],
  },
  docReferences: [
    { kind: 'plan', key: 'ep-05', label: 'EP-05', pages: [1] },
    { kind: 'plan', key: 'ep-07', label: 'EP-07', pages: [4] },
    { kind: 'norm', key: 'önorm b 1600', label: 'ÖNORM B 1600', pages: [3] },
  ],
  coverage: { pages: 40, text: 30, transcribed: 5, drawings: 5, drawingsRead: 3, notRead: 2, reasons: { render_cap: 2 } },
})
const drawing = file('ep05', 'EP-05 Grundriss EG.pdf', {
  dossier: {
    documentType: 'submission_drawing',
    title: null,
    summary: null,
    parties: [],
    dates: [],
    place: null,
    facts: [],
  },
})
const documents = [description, drawing].map((item) => toFindingsDocument(item))
const linksOf = (item: FileItem) => {
  const subject = toFindingsDocument(item)
  return { references: resolveReferences(subject, documents), referencedBy: referencedBy(subject, documents) }
}

describe('DocumentDossier', () => {
  it('shows the type, parties, date, place and the facts with their page', () => {
    render(<DocumentDossier file={description} projectId="p1" links={linksOf(description)} />)
    expect(screen.getByTestId('dossier-type')).toHaveTextContent('Building description')
    expect(screen.getByText('Atelier Lindner Architektur ZT GmbH')).toBeInTheDocument()
    expect(screen.getByText('Hubergasse 14, Wien')).toBeInTheDocument()
    const fact = screen.getByTestId('dossier-fact')
    expect(fact).toHaveTextContent('Gross floor area')
    expect(fact).toHaveTextContent('1.245,5 m²')
    expect(fact).toHaveTextContent('p. 3')
  })

  it('links a resolved drawing number and marks the missing one', () => {
    render(<DocumentDossier file={description} projectId="p1" links={linksOf(description)} />)
    const link = within(screen.getByTestId('dossier-reference-resolved')).getByRole('link', { name: 'EP-05' })
    expect(link).toHaveAttribute('href', '/app/projects/p1/files?doc=ep05')
    expect(screen.getByTestId('dossier-reference-missing')).toHaveTextContent('EP-07not in the project')
    expect(screen.getByText('ÖNORM B 1600')).toBeInTheDocument()
  })

  it('says how much was read, and why not the rest', () => {
    render(<DocumentDossier file={description} projectId="p1" links={linksOf(description)} />)
    expect(screen.getByTestId('dossier-coverage')).toHaveTextContent(
      '38 of 40 pages read in full · 2 drawing pages not evaluated (page limit)'
    )
  })

  it('lists who refers to the document', () => {
    render(<DocumentDossier file={drawing} projectId="p1" links={linksOf(drawing)} />)
    const incoming = screen.getByTestId('dossier-referenced-by')
    expect(within(incoming).getByRole('link', { name: 'Baubeschreibung.pdf' })).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=desc'
    )
  })

  it('renders nothing for a document ingestion said nothing about', () => {
    const { container } = render(<DocumentDossier file={file('x', 'x.pdf')} links={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('DocumentFindingsList', () => {
  const response = { findings: deriveDocumentFindings(documents), documentCount: 2, truncated: false, document: null }

  it('lists each finding with links to its documents, and collapses', async () => {
    render(<DocumentFindingsList projectId="p1" response={response} />)
    const missing = screen.getByTestId('finding-missing_plan')
    expect(missing).toHaveTextContent('Drawing number EP-07 is referred to, but no document matches it')
    expect(within(missing).getByRole('link', { name: 'Baubeschreibung.pdf' })).toBeInTheDocument()
    expect(screen.getByTestId('finding-incomplete_read')).toHaveTextContent('2 of 40 pages not read in full (page limit)')

    await userEvent.click(screen.getByRole('button', { name: 'Hide findings' }))
    expect(screen.queryByTestId('finding-missing_plan')).not.toBeInTheDocument()
  })

  it('renders nothing without findings', () => {
    const { container } = render(
      <DocumentFindingsList projectId="p1" response={{ ...response, findings: [] }} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
