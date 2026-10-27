import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'

import { render, screen } from '@/test-utils'
import { I18nProvider } from '@/i18n'
import { FilesHeaderControls } from './files-header-controls'

function german(ui: ReactElement): ReturnType<typeof render> {
  return render(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )
}

function controls(search: { opensSearch?: boolean; onSubmit: () => void; value?: string }, phone = false): ReactElement {
  return (
    <FilesHeaderControls
      phone={phone}
      view="list"
      onViewChange={() => {}}
      renderFilter={() => null}
      search={{ value: search.value ?? '', onChange: () => {}, onSubmit: search.onSubmit, onClear: () => {}, opensSearch: search.opensSearch }}
    />
  )
}

describe('FilesHeaderControls', () => {
  it('is one way into a shelf’s search: the field says Enter searches everything, and Enter does', async () => {
    const onSubmit = vi.fn()
    german(controls({ opensSearch: true, onSubmit, value: 'EP-03' }))
    const field = screen.getByRole('textbox', { name: 'Dateien durchsuchen' })
    expect(field).toHaveAttribute('placeholder', 'Namen filtern, Enter sucht alles …')
    // No second door beside it.
    expect(screen.queryByRole('button', { name: 'Suche' })).toBeNull()
    await userEvent.type(field, '{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('keeps the short placeholder on a phone and where the shelf has no search', () => {
    const { unmount } = german(controls({ opensSearch: true, onSubmit: () => {} }, true))
    expect(screen.getByRole('textbox', { name: 'Dateien durchsuchen' })).toHaveAttribute('placeholder', 'Suchen …')
    unmount()
    german(controls({ onSubmit: () => {} }))
    expect(screen.getByRole('textbox', { name: 'Dateien durchsuchen' })).toHaveAttribute('placeholder', 'Suchen …')
  })
})
