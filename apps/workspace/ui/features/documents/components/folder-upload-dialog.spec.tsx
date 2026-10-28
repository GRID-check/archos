import { describe, expect, it, vi } from 'vitest'
import { useMemo, useState } from 'react'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { FolderUploadDialog } from './folder-upload-dialog'
import { buildFolderUploadPlan, type RevisionChoice, type FolderUploadPlan } from '../lib/folder-upload-plan'
import type { RevisionChange } from '../lib/revision-proposals'
import type { FileItem } from './project-file-workspace'
import { SUGGESTED_SCREENING_POLICY } from '@/lib/upload-screening/policy'

function pathed(relativePath: string, size = 100): File {
  const name = relativePath.split('/').pop()!
  const file = new File(['x'], name, { type: 'application/pdf' })
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true })
  Object.defineProperty(file, 'size', { value: size, configurable: true })
  return file
}

function doc(filename: string, overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: `doc-${filename}`,
    filename,
    displayName: null,
    fileSize: 100,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    originPath: null,
    contentHash: null,
    createdAt: '2026-01-01T00:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    topics: null,
    capture: null,
    assignees: [],
    authoredBy: 'user',
    ...overrides,
  }
}

/** One new file, one that already exists — the shape the question is about. */
function mixedPlan(): FolderUploadPlan {
  return buildFolderUploadPlan({
    files: [pathed('W/New.pdf'), pathed('W/EG.pdf')],
    documents: [doc('EG.pdf')],
    folders: [],
    currentFolderId: null,
  })
}

function renderDialog(plan: FolderUploadPlan | null, onConfirm = vi.fn()) {
  render(
    <FolderUploadDialog
      open
      onOpenChange={vi.fn()}
      plan={plan}
      currentFolderName={null}
      onConfirm={onConfirm}
    />,
  )
  return { onConfirm }
}

describe('FolderUploadDialog', () => {
  it('says what it is doing while the plan is still being worked out', () => {
    renderDialog(null)
    // On a 500-file drop this is seconds long. A bare spinner would leave the
    // reader guessing whether anything is uploading yet.
    expect(screen.getByTestId('folder-upload-planning')).toBeInTheDocument()
    expect(screen.getByTestId('folder-upload-confirm')).toBeDisabled()
  })

  it('offers the update, ticked, and carries the answer to the caller', async () => {
    const { onConfirm } = renderDialog(mixedPlan())

    const toggle = screen.getByTestId('folder-upload-include-updates')
    // Default ON: the gesture is "bring this folder in", and defaulting to off
    // would make the common case a silent no-op that looks like a success.
    expect(within(toggle).getByRole('checkbox')).toBeChecked()
    // The same-name file is a new Fassung too, and the button says so.
    expect(screen.getByTestId('folder-upload-confirm')).toHaveTextContent('Upload 2 files, 1 as a new revision')

    await userEvent.click(within(toggle).getByRole('checkbox'))
    expect(screen.getByTestId('folder-upload-confirm')).toHaveTextContent(/^Upload 1 file$/)

    await userEvent.click(screen.getByTestId('folder-upload-confirm'))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('relabels the rows the reader has just switched off', async () => {
    renderDialog(mixedPlan())
    await userEvent.click(screen.getByText(/Show all/i))
    const details = screen.getByTestId('folder-upload-details')
    expect(within(details).getByText('New revision')).toBeInTheDocument()

    await userEvent.click(
      within(screen.getByTestId('folder-upload-include-updates')).getByRole('checkbox'),
    )

    // A list still labelled „Neue Fassung" under an unticked box describes an
    // upload that is not going to happen.
    expect(within(details).queryByText('New revision')).not.toBeInTheDocument()
    expect(within(details).getByText('Skipped')).toBeInTheDocument()
  })

  it('asks nothing when nothing already exists', () => {
    renderDialog(
      buildFolderUploadPlan({
        files: [pathed('W/New.pdf')],
        documents: [],
        folders: [],
        currentFolderId: null,
      }),
    )
    // Absent, not present-and-unticked: the difference between "nothing to
    // decide" and "decided for you".
    expect(screen.queryByTestId('folder-upload-include-updates')).not.toBeInTheDocument()
    expect(screen.queryByTestId('folder-upload-revisions')).not.toBeInTheDocument()
    // One file is one file: no „Datei(en)", no „Alle 1 Dateien".
    expect(screen.getByTestId('folder-upload-confirm')).toHaveTextContent(/^Upload 1 file$/)
    expect(screen.getByText('Show the file')).toBeInTheDocument()
  })

  it('gives the dialog the focus on open, not the first box', () => {
    renderDialog(mixedPlan())
    // A box wearing the focus ring on open looks more decided than the rows beside it.
    expect(screen.getByTestId('folder-upload-dialog')).toHaveFocus()
  })

  it('still reports a drop that has nothing left to send', () => {
    // Every file identical to what is filed, and filed where this drop would
    // file it. The reader wants to read "already up to date"; what they must
    // not get is a button that would do nothing.
    const file = pathed('W/EG.pdf')
    const digest = `sha256:${'a'.repeat(64)}`
    renderDialog(
      buildFolderUploadPlan({
        files: [file],
        documents: [{ ...doc('EG.pdf'), contentHash: digest, folderId: 'f-w' }],
        folders: [{ id: 'f-w', parentId: null, name: 'W', path: 'W' }],
        currentFolderId: null,
        digests: new Map([[file, digest]]),
      }),
    )

    expect(screen.getByTestId('folder-upload-count-unchanged')).toHaveTextContent('1')
    expect(screen.getByTestId('folder-upload-confirm')).toBeDisabled()
  })

  /*
   * A rename here makes the plan and the corpus two different words for one
   * row. A dialog that only ever says `EG.pdf` is asking a person to approve
   * replacing a document they cannot find in their own file list.
   */
  it('names the document a row will replace when the project calls it something else', () => {
    renderDialog(
      buildFolderUploadPlan({
        files: [pathed('W/EG.pdf')],
        documents: [doc('EG.pdf', { displayName: 'Erdgeschoss — Freigabe' })],
        folders: [],
        currentFolderId: null,
      }),
    )

    const details = screen.getByTestId('folder-upload-details')
    expect(within(details).getByText(/Erdgeschoss — Freigabe/)).toBeInTheDocument()
  })

  it('warns about a file the project already holds under another name, and sends nothing', () => {
    renderDialog(
      buildFolderUploadPlan({
        files: [pathed('W/DECKBLATT.pdf')],
        documents: [doc('Deckblatt.pdf')],
        folders: [],
        currentFolderId: null,
      }),
    )

    const warning = screen.getByTestId('folder-upload-duplicates')
    expect(within(warning).getByText(/Deckblatt\.pdf/)).toBeInTheDocument()
    // Neither an update nor a new document: uploading would add a second copy,
    // so there is nothing to press.
    expect(screen.getByTestId('folder-upload-confirm')).toBeDisabled()
  })

  it('says that unchanged documents filed elsewhere are moved', () => {
    const file = pathed('Statik/EG.pdf')
    const digest = `sha256:${'a'.repeat(64)}`
    renderDialog(
      buildFolderUploadPlan({
        files: [file],
        documents: [doc('EG.pdf', { contentHash: digest, folderId: null })],
        folders: [{ id: 'f-statik', parentId: null, name: 'Statik', path: 'Statik' }],
        currentFolderId: null,
        digests: new Map([[file, digest]]),
      }),
    )

    expect(screen.getByTestId('folder-upload-refiled')).toBeInTheDocument()
    // Not one byte to send, and still work to do: a disabled button here would
    // claim the tree is already reproduced.
    expect(screen.getByTestId('folder-upload-confirm')).toBeEnabled()
  })
})

describe('FolderUploadDialog — loose files', () => {
  function loose(name: string, size = 100): File {
    const file = new File(['x'], name, { type: 'application/pdf' })
    Object.defineProperty(file, 'size', { value: size, configurable: true })
    return file
  }

  function renderFiles(plan: FolderUploadPlan | null, currentFolderName: string | null = null) {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <FolderUploadDialog
        open
        onOpenChange={onOpenChange}
        plan={plan}
        currentFolderName={currentFolderName}
        onConfirm={onConfirm}
        kind="files"
      />,
    )
    return { onConfirm, onOpenChange }
  }

  it('asks one file its own question and answers yes to the update', async () => {
    const { onConfirm } = renderFiles(
      buildFolderUploadPlan({
        files: [loose('EG.pdf', 5)],
        documents: [doc('EG.pdf', { displayName: 'Erdgeschoss' })],
        folders: [],
        currentFolderId: null,
      }),
    )

    // A new Fassung, in the same words as a file under another name (ADR-0099); never „version".
    expect(screen.getByText('New revision of “EG.pdf”?')).toBeInTheDocument()
    // Named as the corpus names it, so the reader can find what is replaced, and
    // pointing at where the previous one stays: „Fassungen und Freigabe".
    expect(screen.getByText(/“Erdgeschoss” is already here under this name/)).toHaveTextContent('Revisions and approval')
    expect(screen.getByTestId('folder-upload-confirm')).toHaveTextContent('File as a new revision')
    // No batch furniture around one file.
    expect(screen.queryByTestId('folder-upload-include-updates')).not.toBeInTheDocument()
    expect(screen.queryByTestId('folder-upload-count-new')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('folder-upload-confirm'))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('states an identical file and offers only a way out', async () => {
    const file = loose('EG.pdf')
    const digest = `sha256:${'b'.repeat(64)}`
    const { onOpenChange, onConfirm } = renderFiles(
      buildFolderUploadPlan({
        files: [file],
        documents: [doc('EG.pdf', { contentHash: digest })],
        folders: [],
        currentFolderId: null,
        digests: new Map([[file, digest]]),
      }),
    )

    expect(screen.getByText('Unchanged – already here')).toBeInTheDocument()
    expect(screen.queryByTestId('folder-upload-confirm')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('folder-upload-close'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('offers the move when an identical document is filed elsewhere', () => {
    const file = loose('EG.pdf')
    const digest = `sha256:${'c'.repeat(64)}`
    renderFiles(
      buildFolderUploadPlan({
        files: [file],
        documents: [doc('EG.pdf', { contentHash: digest, folderId: 'f-a' })],
        folders: [
          { id: 'f-a', parentId: null, name: 'A', path: 'A' },
          { id: 'f-b', parentId: null, name: 'B', path: 'B' },
        ],
        currentFolderId: 'f-b',
        digests: new Map([[file, digest]]),
      }),
      'B',
    )

    expect(screen.getByTestId('folder-upload-refiled')).toHaveTextContent('“B”')
    expect(screen.getByTestId('folder-upload-confirm')).toBeEnabled()
  })

  it('shows several files as a batch, without a folder count', () => {
    renderFiles(
      buildFolderUploadPlan({
        files: [loose('EG.pdf'), loose('Neu.pdf')],
        documents: [doc('EG.pdf')],
        folders: [],
        currentFolderId: null,
      }),
    )

    expect(screen.getByText('Upload 2 files?')).toBeInTheDocument()
    expect(screen.getByTestId('folder-upload-count-update')).toHaveTextContent('1')
    expect(screen.queryByTestId('folder-upload-count-folders')).not.toBeInTheDocument()
    expect(screen.getByTestId('folder-upload-include-updates')).toBeInTheDocument()
  })
})

/**
 * ADR-0086: before anything is sent, the reader sees what the office's upload
 * screening holds back and why, and can release a single file.
 */
describe('FolderUploadDialog — upload screening', () => {
  const screened = (released: File[] = []) => {
    const contract = pathed('Akt/Verträge/Architektenvertrag.pdf')
    const plan = buildFolderUploadPlan({
      files: [pathed('Akt/Pläne/EG.pdf'), contract],
      documents: [],
      folders: [],
      currentFolderId: null,
      screening: { policy: SUGGESTED_SCREENING_POLICY, basePath: null, released: new Set(released) },
    })
    return { plan, contract }
  }

  it('lists the excluded file with the rule that caught it, and does not count it as uploading', () => {
    const { plan } = screened()
    render(
      <FolderUploadDialog open onOpenChange={vi.fn()} plan={plan} currentFolderName={null} onConfirm={vi.fn()} onReleaseChange={vi.fn()} />
    )
    const section = screen.getByTestId('folder-upload-excluded')
    expect(within(section).getByText('Akt/Verträge/Architektenvertrag.pdf')).toBeInTheDocument()
    expect(within(section).getByText(/Vertrag/)).toBeInTheDocument()
    expect(screen.getByTestId('folder-upload-confirm')).toHaveTextContent('1')
  })

  it('releases one file when the reader ticks it', async () => {
    const { plan, contract } = screened()
    const onReleaseChange = vi.fn()
    render(
      <FolderUploadDialog open onOpenChange={vi.fn()} plan={plan} currentFolderName={null} onConfirm={vi.fn()} onReleaseChange={onReleaseChange} />
    )
    await userEvent.click(screen.getByTestId('folder-upload-release'))
    expect(onReleaseChange).toHaveBeenCalledWith(contract, true)
  })

  it('keeps a released file in the list, ticked, so the release can be taken back', () => {
    const contract = pathed('Akt/Verträge/Architektenvertrag.pdf')
    const plan = buildFolderUploadPlan({
      files: [contract],
      documents: [],
      folders: [],
      currentFolderId: null,
      screening: { policy: SUGGESTED_SCREENING_POLICY, basePath: null, released: new Set([contract]) },
    })
    render(
      <FolderUploadDialog open onOpenChange={vi.fn()} plan={plan} currentFolderName={null} onConfirm={vi.fn()} onReleaseChange={vi.fn()} />
    )
    expect(screen.getByTestId('folder-upload-release')).toHaveAttribute('data-state', 'checked')
  })
})

/** What the Fassung probe answers for a dropped name (`name-probe-types.ts`). */
function offered(name: string, ids: string[], overrides: { newer?: boolean; unambiguous?: boolean } = {}) {
  return {
    name,
    candidates: ids.map((id) => ({ id, filename: `${id}.pdf`, displayName: null, label: `Index ${id.toUpperCase()}` })),
    newer: overrides.newer ?? true,
    unambiguous: overrides.unambiguous ?? ids.length === 1,
  }
}

/** Forty publisher-export sheets that each continue one document, one that is unclear, one unchanged. */
function exportPlan(count = 40): { plan: FolderUploadPlan; files: File[] } {
  const files = Array.from({ length: count }, (_, index) =>
    pathed(`Export/${index % 2 === 0 ? 'Grundrisse' : 'Schnitte'}/Blatt_${String(index).padStart(2, '0')}_Index_C.pdf`),
  )
  const offers = new Map(files.map((file, index) => [file.name, offered(file.name, [`b${index}`])]))
  const plan = buildFolderUploadPlan({ files, documents: [], folders: [], currentFolderId: null, revisionOffers: offers })
  return { plan, files }
}

describe('FolderUploadDialog — new Fassungen, by the same name and across names (ADR-0054, ADR-0099)', () => {
  const renderPlan = (plan: FolderUploadPlan, onRevisionChange: (change: RevisionChange) => void = vi.fn()) =>
    render(
      <FolderUploadDialog open onOpenChange={vi.fn()} plan={plan} currentFolderName={null} onConfirm={vi.fn()} onRevisionChange={onRevisionChange} />,
    )

  it('shows forty clear matches as ONE list under a master box, ticked, grouped by folder, file name first', () => {
    const { plan } = exportPlan()
    renderPlan(plan)

    expect(within(screen.getByTestId('folder-upload-revisions')).getByText('40 new revisions')).toBeInTheDocument()
    const section = screen.getByTestId('folder-upload-revisions-detected')
    const rows = within(section).getAllByTestId('folder-upload-revision-row')
    expect(rows).toHaveLength(40)
    expect(screen.getByTestId('folder-upload-revision-master')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('folder-upload-revision-master-label')).toHaveTextContent('All 40 as new revisions')
    // One run per folder, named once over its rows, instead of the folder prefix eating every row's width.
    const groups = within(section).getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Export/Grundrisse', 'Export/Schnitte'])
    expect(within(groups[0]).getAllByTestId('folder-upload-revision-row')).toHaveLength(20)
    expect(rows[0]).not.toHaveTextContent('Export/')
    expect(rows[0]).toHaveTextContent('Blatt_00_Index_C.pdf')
    // Then where it goes, with the label of the document it continues.
    expect(rows[0]).toHaveTextContent('Revision of b0.pdf · Index B0')
    expect(screen.queryByTestId('folder-upload-revisions-unclear')).not.toBeInTheDocument()
  })

  it('says once what filing as a new Fassung does, and what unticking does', () => {
    renderPlan(exportPlan(2).plan)

    const section = screen.getByTestId('folder-upload-revisions')
    expect(section).toHaveTextContent('The older revision stays readable')
    expect(section).toHaveTextContent('notes what changed')
    expect(section).toHaveTextContent('unticked files come in as separate documents')
    expect(section).toHaveTextContent('can be undone later')
  })

  it('answers the master box for the whole group in one change', async () => {
    const { plan, files } = exportPlan(3)
    const onRevisionChange = vi.fn()
    renderPlan(plan, onRevisionChange)

    await userEvent.click(screen.getByTestId('folder-upload-revision-master'))

    // All were ticked, so the click unticks all, as one change.
    expect(onRevisionChange).toHaveBeenCalledTimes(1)
    const change = onRevisionChange.mock.calls[0][0]
    expect(change.chosen).toBe(false)
    expect(new Set(change.files)).toEqual(new Set(files))
  })

  it('overrides one row, shows the master half-filled with its count, and moves the confirm label', async () => {
    const { files } = exportPlan(3)
    const onRevisionChange = vi.fn()
    const offers = new Map(files.map((file, index) => [file.name, offered(file.name, [`b${index}`])]))
    const plan = buildFolderUploadPlan({
      files,
      documents: [],
      folders: [],
      currentFolderId: null,
      revisionOffers: offers,
      revisionChoices: new Map([[files[1], { chosen: false }]]),
    })
    renderPlan(plan, onRevisionChange)

    expect(screen.getByTestId('folder-upload-revision-master')).toHaveAttribute('data-state', 'indeterminate')
    expect(screen.getByTestId('folder-upload-revision-master-label')).toHaveTextContent('2 of 3 as new revisions')
    expect(screen.getByTestId('folder-upload-confirm')).toHaveTextContent('Upload 3 files, 2 as new revisions')
    const boxes = screen.getAllByTestId('folder-upload-revision-choice')
    expect(boxes.map((box) => box.getAttribute('data-state'))).toEqual(['checked', 'checked', 'unchecked'])

    // Sorted by folder: the unticked one (in Schnitte) comes last. A tap on its name toggles it too.
    const rows = screen.getAllByTestId('folder-upload-revision-row')
    await userEvent.click(within(rows[2]).getByText(/Blatt_01/))
    expect(onRevisionChange).toHaveBeenCalledWith({ files: [files[1]], chosen: true })
  })

  it('counts nothing as a new Fassung when every box is unticked: all files still upload, as documents of their own', () => {
    const { files } = exportPlan(2)
    const plan = buildFolderUploadPlan({
      files,
      documents: [],
      folders: [],
      currentFolderId: null,
      revisionOffers: new Map(files.map((file, index) => [file.name, offered(file.name, [`b${index}`])])),
      revisionChoices: new Map(files.map((file) => [file, { chosen: false }])),
    })
    renderPlan(plan)

    expect(screen.getByTestId('folder-upload-revision-master-label')).toHaveTextContent('None of 2 as new revisions')
    expect(screen.getByTestId('folder-upload-confirm')).toHaveTextContent(/^Upload 2 files$/)
  })

  it('asks the same-name files and the name series in ONE block, in the same words', () => {
    const series = pathed('W/Blatt_Index_C.pdf')
    const plan = buildFolderUploadPlan({
      files: [pathed('W/EG.pdf'), series],
      documents: [doc('EG.pdf')],
      folders: [],
      currentFolderId: null,
      revisionOffers: new Map([[series.name, offered(series.name, ['b'])]]),
    })
    renderPlan(plan)

    const block = screen.getByTestId('folder-upload-revisions')
    expect(within(block).getByText('2 new revisions')).toBeInTheDocument()
    // Each group says why Piloti thinks so.
    const sameName = within(block).getByTestId('folder-upload-include-updates')
    expect(sameName).toHaveTextContent('1 file of the same name as a new revision')
    expect(sameName).toHaveTextContent('Same name as a document here')
    expect(within(block).getByTestId('folder-upload-revisions-detected')).toHaveTextContent('Name series')
    expect(screen.getByTestId('folder-upload-confirm')).toHaveTextContent('Upload 2 files, 2 as new revisions')
  })

  it('labels a ticked offer „New revision" in the full list, and an unticked one „New"', async () => {
    const { files } = exportPlan(2)
    const plan = buildFolderUploadPlan({
      files,
      documents: [],
      folders: [],
      currentFolderId: null,
      revisionOffers: new Map(files.map((file, index) => [file.name, offered(file.name, [`b${index}`])])),
      revisionChoices: new Map([[files[1], { chosen: false }]]),
    })
    renderPlan(plan)
    await userEvent.click(screen.getByText('Show all 2 files'))

    expect(screen.getByTestId('folder-upload-action-revision')).toHaveTextContent('New revision')
    expect(screen.getByTestId('folder-upload-action-new')).toHaveTextContent('New')
  })

  it('keeps the ones that need the reader apart, unticked, with a subject, and nothing preselected', () => {
    const several = pathed('Export/Schnitt_AA_Index_D.pdf')
    const older = pathed('Export/Schnitt_BB_Index_A.pdf')
    const plan = buildFolderUploadPlan({
      files: [several, older, pathed('Export/Grundriss_Index_C.pdf')],
      documents: [],
      folders: [],
      currentFolderId: null,
      revisionOffers: new Map([
        [several.name, offered(several.name, ['c', 'b'])],
        [older.name, offered(older.name, ['c'], { newer: false, unambiguous: false })],
        ['Grundriss_Index_C.pdf', offered('Grundriss_Index_C.pdf', ['g'])],
      ]),
    })
    renderPlan(plan)

    expect(within(screen.getByTestId('folder-upload-revisions-detected')).getAllByTestId('folder-upload-revision-row')).toHaveLength(1)
    const unclear = screen.getByTestId('folder-upload-revisions-unclear')
    expect(within(unclear).getByText('2 files need your choice')).toBeInTheDocument()
    // The hint says what choosing does: it ticks.
    expect(unclear).toHaveTextContent('Choose a document or tick the file, and it is filed as a new revision.')
    const rows = within(unclear).getAllByTestId('folder-upload-revision-unclear-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Several documents could be meant')
    // Unticked, so the field shows its placeholder rather than a document that looks chosen.
    const pick = within(rows[0]).getByTestId('folder-upload-revision-pick')
    expect(pick).toHaveAttribute('data-placeholder')
    expect(pick).toHaveTextContent('Choose the document…')
    expect(rows[1]).toHaveTextContent('Not newer than the current revision “c.pdf”')
    expect(within(rows[1]).queryByTestId('folder-upload-revision-pick')).not.toBeInTheDocument()
    for (const box of within(unclear).getAllByTestId('folder-upload-revision-choice')) {
      expect(box).toHaveAttribute('data-state', 'unchecked')
    }
  })

  it('shows the chosen document in the field once the reader has chosen one', () => {
    const several = pathed('Export/Schnitt_AA_Index_D.pdf')
    const plan = buildFolderUploadPlan({
      files: [several, pathed('Export/Other.pdf')],
      documents: [],
      folders: [],
      currentFolderId: null,
      revisionOffers: new Map([[several.name, offered(several.name, ['c', 'b'])]]),
      revisionChoices: new Map([[several, { targetId: 'b', chosen: true }]]),
    })
    renderPlan(plan)

    const pick = screen.getByTestId('folder-upload-revision-pick')
    expect(pick).not.toHaveAttribute('data-placeholder')
    expect(pick).toHaveTextContent('b.pdf · Index B')
  })

  it('asks nothing of a drop whose names continue nothing, and of an unchanged re-export', () => {
    const reexport = pathed('Export/EG_Grundriss_Index_C.pdf', 100)
    const plan = buildFolderUploadPlan({
      files: [reexport],
      documents: [doc('EG_Grundriss_Index_C.pdf', { fileSize: 100, contentHash: 'sha' })],
      folders: [],
      currentFolderId: null,
      digests: new Map([[reexport, 'sha']]),
      revisionOffers: new Map([[reexport.name, offered(reexport.name, ['b'])]]),
    })
    render(<FolderUploadDialog open onOpenChange={vi.fn()} plan={plan} currentFolderName={null} onConfirm={vi.fn()} />)

    expect(screen.queryByTestId('folder-upload-revisions')).not.toBeInTheDocument()
    expect(screen.getByTestId('folder-upload-count-unchanged')).toHaveTextContent('1')
    expect(screen.getByTestId('folder-upload-action-unchanged')).toBeInTheDocument()
  })

  it('cannot be answered without a handler: the boxes are disabled', () => {
    render(<FolderUploadDialog open onOpenChange={vi.fn()} plan={exportPlan(2).plan} currentFolderName={null} onConfirm={vi.fn()} />)

    expect(screen.getByTestId('folder-upload-revision-master')).toBeDisabled()
  })
})

/**
 * One loose file that continues a document under another name: its own light
 * layout, like the same-name single file, and two named outcomes instead of a
 * master box over a list of one.
 */
describe('FolderUploadDialog — one file that continues a document', () => {
  /** The dialog with its answers re-planned, as `useUploadDecision` does, and what the confirm saw. */
  function Answering({
    file,
    offer,
    onConfirm,
  }: {
    file: File
    offer: ReturnType<typeof offered>
    onConfirm: (plan: FolderUploadPlan) => void
  }) {
    const [choices, setChoices] = useState<Map<File, RevisionChoice>>(new Map())
    const plan = useMemo(
      () =>
        buildFolderUploadPlan({
          files: [file],
          documents: [],
          folders: [],
          currentFolderId: null,
          revisionOffers: new Map([[file.name, offer]]),
          revisionChoices: choices,
        }),
      [file, offer, choices],
    )
    const change = ({ chosen, targetId }: RevisionChange) =>
      setChoices(new Map([[file, { ...choices.get(file), ...(targetId ? { targetId, chosen: chosen ?? true } : { chosen }) }]]))
    return (
      <FolderUploadDialog
        open
        onOpenChange={vi.fn()}
        plan={plan}
        currentFolderName={null}
        onConfirm={() => onConfirm(plan)}
        onRevisionChange={change}
        kind="files"
      />
    )
  }

  const loose = (name: string) => new File(['x'], name, { type: 'application/pdf' })

  it('asks the one question in its own words, without stat tiles, master box or file list', () => {
    const file = loose('EG_Index_C.pdf')
    render(<Answering file={file} offer={offered(file.name, ['b'])} onConfirm={vi.fn()} />)

    expect(screen.getByTestId('folder-upload-dialog')).toHaveAttribute('data-kind', 'single-revision')
    expect(screen.getByText('New revision of “b.pdf”?')).toBeInTheDocument()
    expect(screen.getByText(/“EG_Index_C\.pdf” continues “b\.pdf”/)).toHaveTextContent('notes what changed')
    expect(screen.queryByTestId('folder-upload-count-new')).not.toBeInTheDocument()
    expect(screen.queryByTestId('folder-upload-revision-master')).not.toBeInTheDocument()
    expect(screen.queryByTestId('folder-upload-details')).not.toBeInTheDocument()
    expect(screen.getByTestId('folder-upload-sole-revision')).toHaveTextContent('File as a new revision')
    expect(screen.getByTestId('folder-upload-sole-separate')).toHaveTextContent('Upload as a separate document')
  })

  it('files it as the new Fassung with the first button', async () => {
    const file = loose('EG_Index_C.pdf')
    const onConfirm = vi.fn()
    render(<Answering file={file} offer={offered(file.name, ['b'])} onConfirm={onConfirm} />)

    await userEvent.click(screen.getByTestId('folder-upload-sole-revision'))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].files[0].revisionOf).toMatchObject({ chosen: true, of: { id: 'b' } })
  })

  it('uploads it as a document of its own with the second, and confirms only once the plan carries that answer', async () => {
    const file = loose('EG_Index_C.pdf')
    const onConfirm = vi.fn()
    render(<Answering file={file} offer={offered(file.name, ['b'])} onConfirm={onConfirm} />)

    await userEvent.click(screen.getByTestId('folder-upload-sole-separate'))

    // Confirming in the same tick would have applied the plan with the box still ticked.
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].files[0].revisionOf.chosen).toBe(false)
  })

  it('cannot file a file that could continue two documents until the reader has chosen which', async () => {
    const file = loose('EG_Index_C.pdf')
    const onConfirm = vi.fn()
    render(<Answering file={file} offer={offered(file.name, ['c', 'b'])} onConfirm={onConfirm} />)

    expect(screen.getByText('Is “EG_Index_C.pdf” a new revision?')).toBeInTheDocument()
    expect(screen.getByTestId('folder-upload-revision-pick')).toHaveTextContent('Choose the document…')
    expect(screen.getByTestId('folder-upload-sole-revision')).toBeDisabled()
    // A document of its own needs no choice.
    expect(screen.getByTestId('folder-upload-sole-separate')).toBeEnabled()
  })

  it('leads with the separate document when the file is not newer than the one it would continue', () => {
    const file = loose('EG_Index_A.pdf')
    render(<Answering file={file} offer={offered(file.name, ['c'], { newer: false, unambiguous: false })} onConfirm={vi.fn()} />)

    expect(screen.getByText(/is not newer than “c\.pdf”/)).toBeInTheDocument()
    expect(screen.getByTestId('folder-upload-sole-separate').className).toContain('bg-primary')
    expect(screen.getByTestId('folder-upload-sole-revision').className).not.toContain('bg-primary')
  })
})
