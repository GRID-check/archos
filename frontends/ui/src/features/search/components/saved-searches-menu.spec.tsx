import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'

import { render, screen, waitFor } from '@/test-utils'
import { I18nProvider } from '@/i18n'
import { SEARCH_FIXTURE_SAVED } from '@/app/dev/_fixtures/search'
import { SavedSearchesMenu, type SavedSearchesMenuProps } from './saved-searches-menu'

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

function german(ui: ReactElement): ReturnType<typeof render> {
  return render(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )
}

function menu(props: Partial<SavedSearchesMenuProps> = {}): SavedSearchesMenuProps {
  return {
    items: SEARCH_FIXTURE_SAVED,
    failed: false,
    onApply: vi.fn(),
    onToggleShare: vi.fn(),
    onRename: vi.fn().mockResolvedValue('renamed'),
    onDelete: vi.fn(),
    onUndoDelete: vi.fn(),
    onSave: vi.fn().mockResolvedValue(true),
    ...props,
  }
}

describe('SavedSearchesMenu', () => {
  it('names the colleague who shared a search, and says „Geteilt“ under one’s own shared one', async () => {
    german(<SavedSearchesMenu {...menu()} />)
    await userEvent.click(screen.getByTestId('saved-searches'))
    expect(await screen.findByText('Geteilt von Max Gruber')).toBeInTheDocument()
    expect(screen.getByText('Geteilt')).toBeInTheDocument()
  })

  it('says under each name what the search asks, in the chips’ words', async () => {
    german(<SavedSearchesMenu {...menu()} />)
    await userEvent.click(screen.getByTestId('saved-searches'))
    const summaries = (await screen.findAllByTestId('saved-search-summary')).map((line) => line.textContent)
    expect(summaries).toEqual(['Planliste · Einreichplan · Nur aktuelle Fassung', 'Verweist auf: ÖNORM B 1600'])
  })

  it('shares, stops sharing, renames and deletes one’s own in its ⋯; a colleague’s has none', async () => {
    const props = menu()
    german(<SavedSearchesMenu {...props} />)
    await userEvent.click(screen.getByTestId('saved-searches'))
    expect(await screen.findAllByTestId('saved-search-actions')).toHaveLength(1)
    await userEvent.click(screen.getByTestId('saved-search-actions'))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Nicht mehr teilen', 'Umbenennen', 'Löschen'])
    await userEvent.click(screen.getByTestId('saved-search-share'))
    expect(props.onToggleShare).toHaveBeenCalledWith(SEARCH_FIXTURE_SAVED[0])
  })

  it('renames in a dialog, and says so under the field when the name is taken', async () => {
    const props = menu({ onRename: vi.fn().mockResolvedValueOnce('taken').mockResolvedValueOnce('renamed') })
    german(<SavedSearchesMenu {...props} />)
    await userEvent.click(screen.getByTestId('saved-searches'))
    await userEvent.click(await screen.findByTestId('saved-search-actions'))
    await userEvent.click(screen.getByTestId('saved-search-rename'))
    const field = await screen.findByTestId('saved-search-rename-name')
    expect(field).toHaveValue('Einreichpläne, aktuell')
    await userEvent.clear(field)
    await userEvent.type(field, 'Zitiert ÖNORM B 1600')
    await userEvent.click(screen.getByTestId('saved-search-rename-confirm'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Eine Ihrer Suchen heißt schon so.')
    await userEvent.clear(field)
    await userEvent.type(field, 'Einreichung Seestadt')
    await userEvent.click(screen.getByTestId('saved-search-rename-confirm'))
    expect(props.onRename).toHaveBeenLastCalledWith(SEARCH_FIXTURE_SAVED[0], 'Einreichung Seestadt')
    await waitFor(() => expect(screen.queryByTestId('saved-search-rename-name')).not.toBeInTheDocument())
  })

  it('falls back to „a colleague“ when the directory cannot name them', async () => {
    const [mine, theirs] = SEARCH_FIXTURE_SAVED
    german(<SavedSearchesMenu {...menu({ items: [mine!, { ...theirs!, ownerName: null }] })} />)
    await userEvent.click(screen.getByTestId('saved-searches'))
    expect(await screen.findByText('Aus dem Büro geteilt')).toBeInTheDocument()
  })

  it('deletes with „Rückgängig“ in a toast, which takes the delete back', async () => {
    const props = menu()
    german(<SavedSearchesMenu {...props} undoMs={4000} />)
    await userEvent.click(screen.getByTestId('saved-searches'))
    await userEvent.click(await screen.findByTestId('saved-search-actions'))
    await userEvent.click(screen.getByTestId('saved-search-delete'))
    const mine = SEARCH_FIXTURE_SAVED[0]!
    expect(props.onDelete).toHaveBeenCalledWith(mine)
    expect(toast).toHaveBeenCalledWith('„Einreichpläne, aktuell“ gelöscht', expect.objectContaining({ duration: 4000 }))
    const options = toast.mock.calls.at(-1)?.[1] as { action: { label: string; onClick: () => void } }
    expect(options.action.label).toBe('Rückgängig')
    options.action.onClick()
    expect(props.onUndoDelete).toHaveBeenCalledWith(mine)
  })

  it('saves from inside the list: the dialog opens with the name the search suggests, ready to save', async () => {
    const props = menu({ suggestedName: 'Fluchtweg GK 4, Einreichplan' })
    german(<SavedSearchesMenu {...props} />)
    await userEvent.click(screen.getByTestId('saved-searches'))
    await userEvent.click(await screen.findByTestId('saved-search-save'))
    const name = await screen.findByTestId('saved-search-name')
    expect(name).toHaveValue('Fluchtweg GK 4, Einreichplan')
    const confirm = screen.getByTestId('saved-search-confirm')
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)
    expect(props.onSave).toHaveBeenCalledWith({ name: 'Fluchtweg GK 4, Einreichplan', shared: false })
    await waitFor(() => expect(screen.queryByTestId('saved-search-name')).not.toBeInTheDocument())
  })

  it('says a name is missing instead of greying out the button', async () => {
    const props = menu({ suggestedName: '' })
    german(<SavedSearchesMenu {...props} />)
    await userEvent.click(screen.getByTestId('saved-searches'))
    await userEvent.click(await screen.findByTestId('saved-search-save'))
    const confirm = await screen.findByTestId('saved-search-confirm')
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)
    expect(props.onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Bitte der Suche einen Namen geben.')
    expect(screen.getByTestId('saved-search-name')).toHaveAttribute('aria-invalid', 'true')
    await userEvent.type(screen.getByTestId('saved-search-name'), 'Brandschutz')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
