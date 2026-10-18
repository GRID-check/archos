/**
 * What is still open on a document, where an architect scans a folder: the
 * card's footer and the list's row carry the live Anmerkungen the listing
 * counted, how many are the reader's, and a press that opens the review of
 * that document (the page's own URL with `doc` and `review=1`, which the
 * shelf already answers), never the file preview the row itself opens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

const push = vi.hoisted(() => vi.fn<(href: string, options?: unknown) => void>())
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects/proj-1/files',
  useSearchParams: () => new URLSearchParams(),
}))

import { fireEvent, render, screen, within } from '@/test-utils'
import { FileCard } from './file-card'
import { FileListView } from './file-list-view'
import type { FileItem } from './project-file-workspace'

const doc = (overrides: Partial<FileItem> = {}): FileItem => ({
  id: 'doc-1',
  filename: 'Grundriss_EG.pdf',
  displayName: null,
  fileSize: 1_000,
  contentType: 'application/x-unknown',
  status: 'ready',
  folderId: null,
  createdAt: '2026-06-01T09:00:00Z',
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

beforeEach(() => {
  push.mockReset()
  window.history.replaceState(null, '', '/app/projects/proj-1/files?folder=f-1')
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** jsdom counts every focus as keyboard focus, which is the case the tooltip opens for. */
function focusVisible() {
  const matches = Element.prototype.matches
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    return selector === ':focus-visible' ? true : matches.call(this, selector)
  })
}

describe('the open Anmerkungen on a file card', () => {
  it('says how many are open and how many are the reader’s, and opens the review, not the card', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<FileCard file={doc({ marks: { open: 3, proposed: 0, forYou: 1 } })} isSelected={false} onSelect={onSelect} locale="en" />)

    const chip = screen.getByRole('button', { name: '3 open annotations, 1 for you in “Grundriss_EG.pdf”' })
    await user.click(chip)

    expect(push).toHaveBeenCalledWith('/app/projects/proj-1/files?folder=f-1&doc=doc-1&review=1', { scroll: false })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('says it in words, not as bare numbers, and the whole sentence in its tooltip', () => {
    focusVisible()
    render(<FileCard file={doc({ marks: { open: 4, proposed: 0, forYou: 2 } })} isSelected={false} onSelect={vi.fn()} locale="en" />)

    const chip = screen.getByTestId('open-marks')
    expect(chip).toHaveTextContent('4 open · 2 for you')
    fireEvent.focus(chip)
    expect(screen.getByRole('tooltip')).toHaveTextContent('4 open annotations, 2 for you')
  })

  it('keeps the size and the date in the footer, the chip beside them rather than in their place', () => {
    render(
      <FileCard
        file={doc({ fileSize: 1_900_000, marks: { open: 4, proposed: 0, forYou: 2 } })}
        isSelected={false}
        onSelect={vi.fn()}
        locale="en"
      />,
    )
    const footer = screen.getByTestId('file-card-footer')
    expect(within(footer).getByTestId('open-marks')).toBeInTheDocument()
    expect(footer).toHaveTextContent('1.9 MB')
    expect(footer.querySelector('time')).not.toBeNull()
  })

  it('names the count alone when none is the reader’s, and one in the singular', () => {
    render(<FileCard file={doc({ marks: { open: 1, proposed: 0, forYou: 0 } })} isSelected={false} onSelect={vi.fn()} locale="en" />)
    expect(screen.getByRole('button', { name: '1 open annotation in “Grundriss_EG.pdf”' })).toHaveTextContent('1 open')
  })

  it('names the document it opens, so two rows with the same count are told apart', () => {
    render(
      <FileListView
        files={[doc({ marks: { open: 2, proposed: 0, forYou: 0 } }), doc({ id: 'doc-2', filename: 'Schnitt_AA.pdf', marks: { open: 2, proposed: 0, forYou: 0 } })]}
        selectedFileId={null}
        onSelectFile={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: '2 open annotations in “Grundriss_EG.pdf”' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2 open annotations in “Schnitt_AA.pdf”' })).toBeInTheDocument()
  })

  it('tells Piloti’s proposals nobody took over apart from what is open, as Offene Punkte and the Protokoll count', () => {
    focusVisible()
    render(<FileCard file={doc({ marks: { open: 2, proposed: 12, forYou: 1 } })} isSelected={false} onSelect={vi.fn()} locale="en" />)
    const chip = screen.getByRole('button', {
      name: '2 open annotations, 1 for you and 12 proposals from Piloti in “Grundriss_EG.pdf”',
    })
    expect(chip).toHaveTextContent('2 open · 1 for you · 12 proposals')
    fireEvent.focus(chip)
    expect(screen.getByRole('tooltip')).toHaveTextContent('2 open annotations, 1 for you and 12 proposals from Piloti')
  })

  it('names only the proposals when nothing of the office’s own is open', () => {
    render(<FileCard file={doc({ marks: { open: 0, proposed: 1, forYou: 0 } })} isSelected={false} onSelect={vi.fn()} locale="en" />)
    expect(screen.getByRole('button', { name: '1 proposal from Piloti in “Grundriss_EG.pdf”' })).toHaveTextContent('1 proposal')
  })

  it('shows nothing where nothing is open', () => {
    const { rerender } = render(<FileCard file={doc()} isSelected={false} onSelect={vi.fn()} locale="en" />)
    expect(screen.queryByTestId('open-marks')).toBeNull()
    rerender(<FileCard file={doc({ marks: { open: 0, proposed: 0, forYou: 0 } })} isSelected={false} onSelect={vi.fn()} locale="en" />)
    expect(screen.queryByTestId('open-marks')).toBeNull()
  })
})

describe('the open Anmerkungen on a list row', () => {
  it('sits by the name and opens the review; neither a click nor Enter on it opens the row', async () => {
    const onSelectFile = vi.fn()
    const user = userEvent.setup()
    render(<FileListView files={[doc({ marks: { open: 4, proposed: 0, forYou: 0 } })]} selectedFileId={null} onSelectFile={onSelectFile} />)

    const chip = screen.getByRole('button', { name: '4 open annotations in “Grundriss_EG.pdf”' })
    expect(chip).toHaveTextContent('4 open')
    await user.click(chip)
    chip.focus()
    await user.keyboard('{Enter}')

    expect(push).toHaveBeenCalledTimes(2)
    expect(push).toHaveBeenLastCalledWith('/app/projects/proj-1/files?folder=f-1&doc=doc-1&review=1', { scroll: false })
    expect(onSelectFile).not.toHaveBeenCalled()
  })
})
