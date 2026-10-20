/**
 * A listing row's menu, built on the first ask.
 *
 * A folder of a thousand documents mounts a thousand of these. What is pinned
 * here is that a row nobody opened carries no menu of its own yet, and that the
 * one press, key or right-click that asks for it opens it: nothing waits for a
 * second attempt, and the tile under the pointer is not remounted.
 */

import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { DocumentActionsTrigger, DocumentObjectMenu } from './document-object-menu'

const DOCUMENT = { id: 'doc-1', filename: 'Einreichplan_EG.pdf', displayName: null, folderId: null }
const FIRE_SAFETY = { id: 'f1', name: 'Brandschutz', parentId: null }

function Row() {
  return (
    <DocumentObjectMenu
      document={DOCUMENT}
      scope="files"
      destinations={[{ folder: FIRE_SAFETY, label: 'Brandschutz' }]}
    >
      <div data-testid="tile">
        Einreichplan_EG.pdf
        <DocumentActionsTrigger />
      </div>
    </DocumentObjectMenu>
  )
}

describe('DocumentObjectMenu — built on the first ask', () => {
  it('starts as a plain ⋯ button: no dropdown is mounted for a row nobody opened', () => {
    render(<Row />)
    const trigger = screen.getByTestId('document-actions-trigger')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // A mounted dropdown trigger carries its state; the stand-in carries none.
    expect(trigger).not.toHaveAttribute('data-state')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens on the first press of the ⋯, with every entry and the move targets', async () => {
    const user = userEvent.setup()
    render(<Row />)

    await user.click(screen.getByTestId('document-actions-trigger'))

    expect(await screen.findByRole('menuitem', { name: /download/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument()
    expect(screen.getByTestId('document-action-move')).toBeInTheDocument()
  })

  it('opens from the keyboard', async () => {
    const user = userEvent.setup()
    render(<Row />)

    screen.getByTestId('document-actions-trigger').focus()
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('menuitem', { name: /rename/i })).toBeInTheDocument()
  })

  it('opens on the first right-click, without remounting the tile', async () => {
    render(<Row />)
    const tile = screen.getByTestId('tile')

    fireEvent.contextMenu(tile, { clientX: 40, clientY: 40 })

    expect(await screen.findByRole('menuitem', { name: /download/i })).toBeInTheDocument()
    expect(screen.getByTestId('tile')).toBe(tile)
  })
})
