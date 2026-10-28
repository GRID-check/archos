import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { FolderPickerSheet } from './folder-picker-sheet'
import { sortedFolderDestinations } from '../lib/folder-path-label'

const DESTINATIONS = sortedFolderDestinations([
  { id: 'a', name: 'Brandschutz', parentId: null },
  { id: 'b', name: 'Fluchtwege', parentId: 'a' },
  { id: 'c', name: 'Statik', parentId: null },
])

function Sheet(props: Partial<Parameters<typeof FolderPickerSheet>[0]> = {}) {
  return (
    <FolderPickerSheet
      open
      onOpenChange={vi.fn()}
      title="Move 3 files to …"
      destinations={DESTINATIONS}
      onPick={vi.fn()}
      {...props}
    />
  )
}

describe('FolderPickerSheet', () => {
  it('lists the top level and every folder by its full path', () => {
    render(<Sheet />)
    expect(screen.getByTestId('folder-picker-root')).toBeInTheDocument()
    expect(screen.getByText('Brandschutz / Fluchtwege')).toBeInTheDocument()
    expect(screen.getByText('Statik')).toBeInTheDocument()
  })

  it('narrows the folders as the reader types, and says when none match', async () => {
    const user = userEvent.setup()
    render(<Sheet />)
    await user.type(screen.getByRole('textbox', { name: 'Search folders' }), 'flucht')
    expect(screen.getByText('Brandschutz / Fluchtwege')).toBeInTheDocument()
    expect(screen.queryByText('Statik')).not.toBeInTheDocument()

    await user.clear(screen.getByRole('textbox', { name: 'Search folders' }))
    await user.type(screen.getByRole('textbox', { name: 'Search folders' }), 'zzz')
    expect(screen.getByText(/No folder matches/)).toBeInTheDocument()
  })

  it('hands the pick back with the folder and its label', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<Sheet onPick={onPick} />)
    await user.click(screen.getByTestId('folder-picker-c'))
    expect(onPick).toHaveBeenCalledWith('c', 'Statik')
    await user.click(screen.getByTestId('folder-picker-root'))
    expect(onPick).toHaveBeenLastCalledWith(null, 'All Files')
  })

  it('marks where the files already are and refuses that row', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<Sheet currentFolderId="c" onPick={onPick} />)
    const here = screen.getByTestId('folder-picker-c')
    expect(here).toBeDisabled()
    expect(here).toHaveAttribute('aria-current', 'true')
    await user.click(here)
    expect(onPick).not.toHaveBeenCalled()
    // The top level is still a place to go.
    expect(screen.getByTestId('folder-picker-root')).toBeEnabled()
  })

  it('treats the top level as „here" when everything stands there', () => {
    render(<Sheet currentFolderId={null} />)
    expect(screen.getByTestId('folder-picker-root')).toBeDisabled()
  })
})
