/**
 * The wizard on a phone: the module list is one bar that opens a sheet, instead
 * of a strip of nine tiles above the first question.
 */
import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectIntakeWizard } from './project-intake-wizard'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const stages = projectIntakeDefinitionV1.stages

describe('ProjectIntakeWizard on a phone', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => projectIntakeDefinitionV1 })),
    )
  })

  it('names the module and the step in one bar, and opens the module list from it', async () => {
    const user = userEvent.setup()
    render(<ProjectIntakeWizard projectId="p1" projectName="Test" />)

    const picker = await screen.findByTestId('intake-module-picker')
    expect(picker).toHaveTextContent(`Modul ${stages[0].id}`)
    expect(picker).toHaveTextContent(`1/${stages.length}`)
    // Finger-sized, and hidden once the rail has the room (`lg`).
    expect(picker).toHaveClass('min-h-11', 'lg:hidden')

    await user.click(picker)
    const sheet = await screen.findByRole('dialog')
    const rows = within(sheet).getAllByRole('button', { name: /./ })
    // Every module is a row of the sheet (the close control is the extra one).
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(stages.length)
    expect(rows.length).toBeGreaterThanOrEqual(stages.length)
  })

  it('goes to the module that is chosen and closes the sheet', async () => {
    const user = userEvent.setup()
    render(<ProjectIntakeWizard projectId="p1" projectName="Test" />)

    await user.click(await screen.findByTestId('intake-module-picker'))
    const sheet = await screen.findByRole('dialog')
    await user.click(within(sheet).getByRole('button', { name: new RegExp(`^3\\s*${stages[2].title}`) }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('intake-module-picker')).toHaveTextContent(`Modul ${stages[2].id}`)
    expect(screen.getByTestId('intake-module-picker')).toHaveTextContent(`3/${stages.length}`)
  })

  it('keeps the step counter in the bar and out of the footer on a phone', async () => {
    render(<ProjectIntakeWizard projectId="p1" projectName="Test" />)
    await screen.findByTestId('intake-module-picker')

    const counter = screen.getByText(`Step 1 of ${stages.length}`)
    expect(counter).toHaveClass('hidden', 'sm:inline')
  })
})
