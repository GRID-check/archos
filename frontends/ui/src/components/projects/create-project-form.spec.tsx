/**
 * Creating a project, running or already closed: what reaches the server
 * action, and what keeps the submit shut.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createProject } from '@/app/app/(shell)/projects/actions'
import { capturePosthog } from '@/lib/analytics/posthog'
import { CreateProjectForm } from './create-project-form'

vi.mock('@/app/app/(shell)/projects/actions', () => ({ createProject: vi.fn() }))
vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: vi.fn() }))

const action = vi.mocked(createProject)

/** The fields of the FormData the action was last called with. */
function sent(): Record<string, string> {
  const formData = action.mock.calls.at(-1)?.[1]
  return Object.fromEntries([...(formData?.entries() ?? [])].map(([key, value]) => [key, String(value)]))
}

async function pick(user: ReturnType<typeof userEvent.setup>, combobox: string, option: string): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: combobox }))
  await user.click(await screen.findByRole('option', { name: option }))
}

const submit = (name: RegExp = /^Create project$/) => screen.getByRole('button', { name })

describe('CreateProjectForm', () => {
  beforeEach(() => {
    // Only the clock: the Abschluss bounds read this month, and userEvent needs real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'))
    action.mockReset()
    action.mockResolvedValue({})
    vi.mocked(capturePosthog).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('a running project sends its name and state=active, and nothing of a close', async () => {
    const user = userEvent.setup()
    render(<CreateProjectForm />)

    expect(submit()).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Ongoing/ })).toBeChecked()
    expect(screen.queryByTestId('create-project-closed')).toBeNull()

    await user.type(screen.getByLabelText('Project name'), '  Wohnhaus Hauptstraße 12 ')
    await user.click(submit())

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(sent()).toEqual({ name: 'Wohnhaus Hauptstraße 12', state: 'active' })
    expect(capturePosthog).toHaveBeenCalledWith('project_created', { state: 'active' })
  })

  test('a closed project needs its outcome, then sends outcome, Beginn and Abschluss', async () => {
    const user = userEvent.setup()
    render(<CreateProjectForm />)

    await user.type(screen.getByLabelText('Project name'), 'Schule Nord')
    await user.click(screen.getByRole('radio', { name: /Closed/ }))

    expect(await screen.findByTestId('create-project-closed')).toBeInTheDocument()
    const closedSubmit = submit(/Create closed project/)
    // Not preselected: a default would nudge the record towards the wrong outcome.
    expect(screen.getByRole('radio', { name: /Completed/ })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /Not realized/ })).not.toBeChecked()
    expect(closedSubmit).toBeDisabled()

    await user.click(screen.getByRole('radio', { name: /Not realized/ }))
    expect(closedSubmit).toBeEnabled()
    await user.click(closedSubmit)

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(sent()).toEqual({
      name: 'Schule Nord',
      state: 'closed',
      outcome: 'cancelled',
      startedOn: '',
      endedOn: '2026-03',
    })
    expect(capturePosthog).toHaveBeenCalledWith('project_created', { state: 'closed' })
  })

  test('sends a chosen Beginn', async () => {
    const user = userEvent.setup()
    render(<CreateProjectForm />)

    await user.type(screen.getByLabelText('Project name'), 'Halle Süd')
    await user.click(screen.getByRole('radio', { name: /Closed/ }))
    await user.click(await screen.findByRole('radio', { name: /Completed/ }))
    await pick(user, 'Start, Month', 'June')
    await pick(user, 'Start, Year', '2019')
    await user.click(submit(/Create closed project/))

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(sent()).toMatchObject({ outcome: 'completed', startedOn: '2019-06', endedOn: '2026-03' })
  })

  test('an Abschluss in the future shows the error and keeps the submit shut', async () => {
    const user = userEvent.setup()
    render(<CreateProjectForm />)

    await user.type(screen.getByLabelText('Project name'), 'Villa K')
    await user.click(screen.getByRole('radio', { name: /Closed/ }))
    await user.click(await screen.findByRole('radio', { name: /Completed/ }))
    await pick(user, 'Completion, Month', 'December')

    expect(screen.getByRole('alert')).toHaveTextContent('The completion cannot lie in the future.')
    expect(submit(/Create closed project/)).toBeDisabled()
    expect(action).not.toHaveBeenCalled()
  })

  test("the server's Abschluss reason lands on the Abschluss field, not in a general alert", async () => {
    action.mockResolvedValue({ error: 'refused', reason: 'abschluss-before-beginn' })
    const user = userEvent.setup()
    render(<CreateProjectForm />)

    await user.type(screen.getByLabelText('Project name'), 'Villa K')
    await user.click(screen.getByRole('radio', { name: /Closed/ }))
    await user.click(await screen.findByRole('radio', { name: /Completed/ }))
    await user.click(submit(/Create closed project/))

    expect(await screen.findByText('The completion lies before the start.')).toBeInTheDocument()
    expect(screen.queryByText(/couldn't create this project/)).toBeNull()
    expect(capturePosthog).not.toHaveBeenCalled()
  })

  test('any other failure shows the calm message, never the raw error', async () => {
    action.mockResolvedValue({ error: 'duplicate key value violates unique constraint' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<CreateProjectForm />)

    await user.type(screen.getByLabelText('Project name'), 'Villa K')
    await user.click(submit())

    expect(await screen.findByText(/couldn't create this project/)).toBeInTheDocument()
    expect(screen.queryByText(/duplicate key/)).toBeNull()
  })

  test('Cancel calls onCancel without submitting', async () => {
    const onCancel = vi.fn()
    render(<CreateProjectForm onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(action).not.toHaveBeenCalled()
  })
})
