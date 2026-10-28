import { act, fireEvent, render, screen } from '@/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { DOCUMENT_DRAG_TYPE } from '../hooks/use-document-drag'
import { FolderBreadcrumbRow, FolderCard, FolderRow } from './folder-navigation'
import type { FolderItem } from './project-file-workspace'

const FOLDER: FolderItem = { id: 'f-1', parentId: null, name: 'Verträge', path: '/Verträge', ownAccess: null }

function tile() {
  return {
    itemCount: 2,
    onOpen: vi.fn(),
    onRenameFolder: vi.fn(async () => true),
    onDeleteFolder: vi.fn(async () => true),
    onDropFolder: vi.fn(),
  }
}

// #1055: clicking into the rename field opened the folder, because the field
// sat inside the tile's open button and the click bubbled to it.
describe('renaming a folder in place', () => {
  it('keeps the grid tile closed when the name field is clicked', () => {
    const props = tile()
    render(<FolderCard folder={FOLDER} editing onEditingChange={() => {}} {...props} />)
    const input = screen.getByTestId('folder-rename-input-f-1')

    fireEvent.pointerDown(input)
    fireEvent.mouseDown(input)
    fireEvent.click(input)

    expect(props.onOpen).not.toHaveBeenCalled()
    expect(input.closest('button')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open folder “Verträge”' })).toBeNull()
  })

  it('stops the tile being a drag source while its name is edited', () => {
    const props = tile()
    const { rerender } = render(<FolderCard folder={FOLDER} {...props} />)
    expect(screen.getByTestId('folder-card-f-1')).toHaveAttribute('draggable', 'true')

    rerender(<FolderCard folder={FOLDER} editing onEditingChange={() => {}} {...props} />)
    expect(screen.getByTestId('folder-card-f-1')).not.toHaveAttribute('draggable', 'true')
  })

  it('opens the folder again once the rename is done', () => {
    const props = tile()
    render(<FolderCard folder={FOLDER} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open folder “Verträge”' }))
    expect(props.onOpen).toHaveBeenCalledWith('f-1')
  })

  it('keeps the list row closed when the name field is clicked', () => {
    const props = tile()
    render(<FolderRow folder={FOLDER} editing onEditingChange={() => {}} {...props} />)
    fireEvent.click(screen.getByTestId('folder-rename-input-f-1'))
    expect(props.onOpen).not.toHaveBeenCalled()
  })
})

/**
 * Every way up is a drop target: the back control, „Alle Dateien", each
 * ancestor. A document moves there, desktop files upload there, and a level
 * the reader may only read takes neither and says why.
 */
describe('the breadcrumb as a drop target', () => {
  const TREE: FolderItem[] = [
    { id: 'f1', parentId: null, name: 'Planung', path: 'Planung' },
    { id: 'f2', parentId: 'f1', name: 'Statik', path: 'Planung/Statik' },
  ]
  const plan = new File(['x'], 'Plan.pdf', { type: 'application/pdf' })
  const documentDrag = () => ({
    types: [DOCUMENT_DRAG_TYPE],
    getData: (type: string) => (type === DOCUMENT_DRAG_TYPE ? 'd1' : ''),
    dropEffect: 'none',
  })
  const fileDrag = () => ({ types: ['Files'], files: [plan], items: [], dropEffect: 'none', getData: () => '' })

  const row = (mayWriteAt?: (folderId: string | null) => boolean) => {
    const props = { onDropDocument: vi.fn(), onDropFiles: vi.fn(), onFileAim: vi.fn(), onNavigate: vi.fn() }
    render(<FolderBreadcrumbRow folders={TREE} currentFolderId="f2" mayWriteAt={mayWriteAt} {...props} />)
    return props
  }

  it('moves a document dropped on „Alle Dateien" to the top level', () => {
    const props = row()
    const root = screen.getByTestId('crumb-drop-root')
    fireEvent.dragOver(root, { dataTransfer: documentDrag() })
    expect(root).toHaveAttribute('data-drop-over')
    fireEvent.drop(root, { dataTransfer: documentDrag() })
    expect(props.onDropDocument).toHaveBeenCalledWith('d1', null)
  })

  it('uploads desktop files dropped on the parent into the parent', async () => {
    const props = row()
    const parent = screen.getAllByTestId('crumb-drop-f1')[0]
    fireEvent.dragOver(parent, { dataTransfer: fileDrag() })
    expect(props.onFileAim).toHaveBeenLastCalledWith({ folderId: 'f1', refusal: null })
    await act(async () => {
      fireEvent.drop(parent, { dataTransfer: fileDrag() })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(props.onDropFiles).toHaveBeenCalledWith([plan], { truncated: false, unreadable: 0 }, 'f1')
  })

  it('refuses both at a level the reader may only read, and names it', async () => {
    const props = row((folderId) => folderId !== 'f1')
    const parent = screen.getAllByTestId('crumb-drop-f1')[0]

    fireEvent.dragOver(parent, { dataTransfer: documentDrag() })
    fireEvent.drop(parent, { dataTransfer: documentDrag() })
    expect(props.onDropDocument).not.toHaveBeenCalled()

    fireEvent.dragOver(parent, { dataTransfer: fileDrag() })
    const aim = props.onFileAim.mock.lastCall?.[0] as { folderId: string; refusal: string | null }
    expect(aim.folderId).toBe('f1')
    expect(aim.refusal).toContain('Planung')
    await act(async () => {
      fireEvent.drop(parent, { dataTransfer: fileDrag() })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(props.onDropFiles).not.toHaveBeenCalled()
  })
})
