/**
 * The Unterlagen picker: one list, two uses. What is pinned is the contract
 * the callers rely on — a row's role is exclusive (Read beats Exclude and
 * vice versa), the search matches name and title alike, and an add closes the
 * dialog with the document the run is told about.
 */

import { fireEvent, render, screen, within } from '@/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { PlanDocument } from '@/lib/runs/plan-documents'
import { DocumentsDialog } from './DocumentsDialog'

const documents: PlanDocument[] = [
  { name: 'einreichplan_v3.pdf', title: 'Einreichplan', shelf: 'project' },
  { name: 'Brandschutzkonzept.pdf', shelf: 'project' },
  { name: 'OIB-RL 2 Leitfaden.pdf', title: 'Leitfaden OIB 2', shelf: 'archiv' },
]

const rows = () => screen.getAllByTestId('documents-row')

describe('DocumentsDialog', () => {
  describe('pick', () => {
    it('lists every document under its title and reads the roles it was given', () => {
      render(
        <DocumentsDialog
          mode="pick"
          open
          onOpenChange={() => undefined}
          documents={documents}
          basis={['einreichplan_v3.pdf']}
          excluded={['brandschutzkonzept.pdf']}
          onChange={() => undefined}
        />
      )
      expect(screen.getByTestId('documents-dialog')).toBeInTheDocument()
      expect(rows()).toHaveLength(3)
      expect(rows()[0]).toHaveAttribute('data-role', 'basis')
      expect(rows()[0]).toHaveTextContent('Einreichplan')
      // The role match folds case: the plan's edit and the inventory may spell the name apart.
      expect(rows()[1]).toHaveAttribute('data-role', 'excluded')
      expect(rows()[2]).not.toHaveAttribute('data-role')
    })

    it('names a row Read or Excluded, never both, and clears it on a second press', () => {
      const onChange = vi.fn()
      render(
        <DocumentsDialog
          mode="pick"
          open
          onOpenChange={() => undefined}
          documents={documents}
          basis={['einreichplan_v3.pdf']}
          excluded={[]}
          onChange={onChange}
        />
      )
      const first = rows()[0]
      fireEvent.click(within(first).getByRole('button', { name: /Exclude: Einreichplan/ }))
      expect(onChange).toHaveBeenLastCalledWith({
        basis: [],
        excluded: ['einreichplan_v3.pdf'],
      })
      fireEvent.click(within(first).getByRole('button', { name: /Read in full: Einreichplan/ }))
      expect(onChange).toHaveBeenLastCalledWith({ basis: [], excluded: [] })
    })

    it('filters by title and by file name', () => {
      render(
        <DocumentsDialog
          mode="pick"
          open
          onOpenChange={() => undefined}
          documents={documents}
          basis={[]}
          excluded={[]}
          onChange={() => undefined}
        />
      )
      fireEvent.change(screen.getByRole('textbox', { name: 'Search documents' }), {
        target: { value: 'oib' },
      })
      expect(rows()).toHaveLength(1)
      expect(rows()[0]).toHaveTextContent('Leitfaden OIB 2')
      fireEvent.change(screen.getByRole('textbox', { name: 'Search documents' }), {
        target: { value: 'nichts' },
      })
      expect(screen.queryAllByTestId('documents-row')).toHaveLength(0)
      expect(screen.getByText('No documents match.')).toBeInTheDocument()
    })
  })

  describe('add', () => {
    it('adds a row the run has not been told about and closes; a named row offers no add', () => {
      const onAdd = vi.fn()
      const onOpenChange = vi.fn()
      render(
        <DocumentsDialog
          mode="add"
          open
          onOpenChange={onOpenChange}
          documents={documents}
          named={['Einreichplan_v3.pdf']}
          onAdd={onAdd}
        />
      )
      expect(within(rows()[0]).queryByRole('button')).toBeNull()
      expect(rows()[0]).toHaveTextContent('named')
      fireEvent.click(within(rows()[1]).getByRole('button', { name: 'Add Brandschutzkonzept.pdf' }))
      expect(onAdd).toHaveBeenCalledWith(documents[1])
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('names a document from a restricted folder as such and offers no add for it', () => {
      const onAdd = vi.fn()
      render(
        <DocumentsDialog
          mode="add"
          open
          onOpenChange={() => undefined}
          documents={[
            { name: 'Abmahnung_Meier_2026.pdf', title: 'Abmahnung Meier', shelf: 'project', restricted: true },
            { name: 'Brandschutzkonzept.pdf', shelf: 'project', restricted: false },
          ]}
          named={[]}
          onAdd={onAdd}
        />
      )
      expect(within(rows()[0]).queryByRole('button')).toBeNull()
      expect(within(rows()[0]).getByTestId('documents-restricted')).toHaveTextContent('restricted')
      expect(within(rows()[0]).getByTestId('documents-restricted')).toHaveAttribute(
        'title',
        expect.stringContaining('restricted access')
      )
      fireEvent.click(within(rows()[1]).getByRole('button', { name: 'Add Brandschutzkonzept.pdf' }))
      expect(onAdd).toHaveBeenCalledTimes(1)
    })

    it('says it is loading while the inventory has not arrived', () => {
      render(
        <DocumentsDialog
          mode="add"
          open
          onOpenChange={() => undefined}
          documents={[]}
          loading
          named={[]}
          onAdd={() => undefined}
        />
      )
      expect(screen.getByText('Loading documents …')).toBeInTheDocument()
    })
  })
})
