import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test-utils'
import type { FolderItem } from '../file-types'
import { FolderDescriptionDialog, FolderDescriptionLine } from './folder-description-dialog'

const folder = (description: string | null = null): FolderItem => ({
  id: 'f-bescheide',
  parentId: null,
  name: 'Bescheide',
  path: 'Bescheide',
  description,
})

describe('FolderDescriptionDialog', () => {
  it('saves what belongs in the folder, folded and trimmed, and closes', async () => {
    const onSave = vi.fn(async () => true)
    const onOpenChange = vi.fn()
    render(<FolderDescriptionDialog folder={folder()} onOpenChange={onOpenChange} onSave={onSave} />)
    expect(screen.getByText('What belongs in “Bescheide”?')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Description'), '  Bescheide   der MA 37  ')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith('f-bescheide', 'Bescheide der MA 37')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('clears it when emptied, and saves nothing unchanged', async () => {
    const onSave = vi.fn(async () => true)
    render(<FolderDescriptionDialog folder={folder('Bescheide der MA 37')} onOpenChange={vi.fn()} onSave={onSave} />)
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Description'))
    await userEvent.click(save)
    expect(onSave).toHaveBeenCalledWith('f-bescheide', null)
  })

  it('refuses more than 500 characters before it asks the server, and says so', async () => {
    const onSave = vi.fn(async () => true)
    render(<FolderDescriptionDialog folder={folder('x'.repeat(501))} onOpenChange={vi.fn()} onSave={onSave} />)
    expect(screen.getByText('At most 500 characters.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('keeps the dialog open when the server refused', async () => {
    const onOpenChange = vi.fn()
    render(<FolderDescriptionDialog folder={folder()} onOpenChange={onOpenChange} onSave={vi.fn(async () => false)} />)
    await userEvent.type(screen.getByLabelText('Description'), 'Bescheide')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe('FolderDescriptionLine', () => {
  it('shows a described folder to everyone, and its edit only to a writer', async () => {
    const onEdit = vi.fn()
    const { rerender } = render(<FolderDescriptionLine folder={folder('Bescheide der MA 37')} canEdit onEdit={onEdit} />)
    expect(screen.getByText('Bescheide der MA 37')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Edit description' }))
    expect(onEdit).toHaveBeenCalled()
    rerender(<FolderDescriptionLine folder={folder('Bescheide der MA 37')} canEdit={false} onEdit={onEdit} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('invites a writer to describe an undescribed folder, and shows a reader nothing', () => {
    const { rerender } = render(<FolderDescriptionLine folder={folder()} canEdit onEdit={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Describe what belongs here' })).toBeInTheDocument()
    rerender(<FolderDescriptionLine folder={folder()} canEdit={false} onEdit={vi.fn()} />)
    expect(screen.queryByTestId('folder-description-line')).not.toBeInTheDocument()
  })
})
