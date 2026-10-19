import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { FileBrowserPane, type FileBrowserSelection } from './file-browser-pane'
import { SelectionBar } from './selection-bar'
import { useFileSearch } from '../hooks/use-file-search'
import type { FileItem } from './project-file-workspace'

const file = (id: string, filename: string): FileItem => ({
  id,
  filename,
  displayName: null,
  fileSize: 1024,
  contentType: 'image/jpeg',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
})

const FILES = [file('p1', 'IMG_0001.jpg'), file('p2', 'IMG_0002.jpg'), file('p3', 'IMG_0003.jpg')]

function Pane({
  selection,
  onSelectFile = vi.fn(),
  view = 'cards',
}: {
  selection: FileBrowserSelection
  onSelectFile?: (id: string | null) => void
  view?: 'cards' | 'list'
}) {
  const search = useFileSearch(undefined)
  return (
    <FileBrowserPane
      files={FILES}
      selectedFileId={null}
      onSelectFile={onSelectFile}
      isLoading={false}
      search={search}
      view={view}
      selection={selection}
      folderNav={{
        folders: [],
        currentFolderId: null,
        onNavigate: vi.fn(),
        onCreateFolder: vi.fn(async () => true),
        onRenameFolder: vi.fn(async () => true),
        onDeleteFolder: vi.fn(async () => true),
      }}
    />
  )
}

describe('a card in selection mode', () => {
  it('toggles on a press and never opens the preview', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const onSelectFile = vi.fn()
    render(
      <Pane
        onSelectFile={onSelectFile}
        selection={{ active: true, selectedIds: new Set(['p2']), onToggle }}
      />
    )

    const cards = screen.getAllByTestId('file-card')
    await user.click(cards[0]!)
    expect(onToggle).toHaveBeenCalledWith(expect.stringMatching(/^p\d$/))
    expect(onSelectFile).not.toHaveBeenCalled()
  })

  it('says which cards are picked, and offers no ⋯ while picking', () => {
    render(
      <Pane
        selection={{ active: true, selectedIds: new Set(['p2']), onToggle: vi.fn() }}
      />
    )
    const pressed = screen.getAllByTestId('file-card').filter((card) => card.getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
    expect(within(pressed[0]!.parentElement!).getByTestId('file-card-check')).toHaveAttribute('data-checked')
    expect(screen.getAllByTestId('file-card-check')).toHaveLength(3)
  })
})

describe('a card outside selection mode', () => {
  it('opens on a press and carries no selection mark', async () => {
    const user = userEvent.setup()
    const onSelectFile = vi.fn()
    render(
      <Pane
        onSelectFile={onSelectFile}
        selection={{ active: false, selectedIds: new Set(), onToggle: vi.fn(), onStart: vi.fn() }}
      />
    )
    expect(screen.queryByTestId('file-card-check')).not.toBeInTheDocument()
    await user.click(screen.getAllByTestId('file-card')[0]!)
    expect(onSelectFile).toHaveBeenCalledTimes(1)
  })

  it('offers „Auswählen" in the path row, and it starts the mode', async () => {
    const user = userEvent.setup()
    const onStart = vi.fn()
    render(
      <Pane selection={{ active: false, selectedIds: new Set(), onToggle: vi.fn(), onStart }} />
    )
    await user.click(screen.getByTestId('selection-start'))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('has no „Auswählen" where the shelf gives no way in', () => {
    render(<Pane selection={{ active: false, selectedIds: new Set(), onToggle: vi.fn() }} />)
    expect(screen.queryByTestId('selection-start')).not.toBeInTheDocument()
  })
})

describe('a list row in selection mode', () => {
  it('shows a checkbox per row, toggles on a row press, and opens nothing', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const onSelectFile = vi.fn()
    render(
      <Pane
        view="list"
        onSelectFile={onSelectFile}
        selection={{ active: true, selectedIds: new Set(['p1']), onToggle }}
      />
    )
    const checks = screen.getAllByTestId('file-list-check')
    expect(checks).toHaveLength(3)
    const rows = screen.getAllByTestId('file-list-row')
    await user.click(rows[1]!)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onSelectFile).not.toHaveBeenCalled()
  })

  it('does not add the column outside selection mode', () => {
    render(
      <Pane
        view="list"
        selection={{ active: false, selectedIds: new Set(), onToggle: vi.fn() }}
      />
    )
    expect(screen.queryByTestId('file-list-check')).not.toBeInTheDocument()
  })
})

describe('SelectionBar', () => {
  it('announces the count, selects all, moves and finishes', async () => {
    const user = userEvent.setup()
    const onSelectAll = vi.fn()
    const onMove = vi.fn()
    const onDone = vi.fn()
    render(
      <SelectionBar count={2} total={5} canMove onSelectAll={onSelectAll} onMove={onMove} onDone={onDone} />
    )
    expect(screen.getByTestId('selection-count')).toHaveTextContent('2 selected')
    await user.click(screen.getByTestId('selection-all'))
    await user.click(screen.getByTestId('selection-move'))
    await user.click(screen.getByTestId('selection-done'))
    expect(onSelectAll).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('cannot move nothing, and „Alle" is spent once everything is picked', () => {
    const { rerender } = render(
      <SelectionBar count={0} total={3} canMove onSelectAll={vi.fn()} onMove={vi.fn()} onDone={vi.fn()} />
    )
    expect(screen.getByTestId('selection-move')).toBeDisabled()
    rerender(<SelectionBar count={3} total={3} canMove onSelectAll={vi.fn()} onMove={vi.fn()} onDone={vi.fn()} />)
    expect(screen.getByTestId('selection-all')).toBeDisabled()
  })

  it('leaves out Verschieben where the reader may not move', () => {
    render(<SelectionBar count={1} total={3} canMove={false} onSelectAll={vi.fn()} onMove={vi.fn()} onDone={vi.fn()} />)
    expect(screen.queryByTestId('selection-move')).not.toBeInTheDocument()
  })
})
