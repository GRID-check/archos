import { fireEvent, render, screen } from '@/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { FolderCard, FolderRow } from './folder-navigation'
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
