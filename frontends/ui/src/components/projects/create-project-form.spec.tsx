import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { capturePosthog } from '@/lib/analytics/posthog'
import { createProject } from '@/app/app/(shell)/projects/actions'
import { CreateProjectForm } from './create-project-form'

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/lib/analytics/posthog', () => ({
  capturePosthog: vi.fn(),
}))

vi.mock('@/app/app/(shell)/projects/actions', () => ({
  createProject: vi.fn(),
}))

async function submitName(name: string): Promise<void> {
  const user = userEvent.setup()
  render(<CreateProjectForm />)
  await user.type(screen.getByLabelText('Project name'), name)
  await user.click(screen.getByRole('button', { name: /create/i }))
}

describe('CreateProjectForm', () => {
  beforeEach(() => {
    vi.mocked(createProject).mockReset()
    vi.mocked(capturePosthog).mockClear()
    push.mockClear()
  })

  // A server action that calls redirect() rejects a direct caller with
  // NEXT_REDIRECT, so the capture after the await never ran. The action answers
  // with the id instead, and the form owns both the event and the navigation.
  test('captures project_created and opens intake after a create', async () => {
    vi.mocked(createProject).mockResolvedValue({ projectId: 'p1' })

    await submitName('Seestadt')

    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/projects/p1/intake'))
    expect(capturePosthog).toHaveBeenCalledWith('project_created')
  })

  test('shows a calm error and stays put when the create fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createProject).mockResolvedValue({ error: 'duplicate key value' })

    await submitName('Seestadt')

    expect(await screen.findByText(/couldn't create this project/i)).toBeDefined()
    expect(screen.queryByText(/duplicate key/i)).toBeNull()
    expect(capturePosthog).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })
})
