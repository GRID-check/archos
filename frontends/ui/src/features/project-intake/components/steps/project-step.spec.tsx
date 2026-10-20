/**
 * Step 1, Projekt: what the dialog took, shown and editable through the
 * profile's door, and the Beteiligte, colleagues with a role and externals with
 * a Funktion, against the preview's in-memory client. „Weiter zur Ablage" is
 * always there.
 */
import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createFixtureParticipantsClient,
  PROJECT_STEP_FIXTURES,
  type ProjectStepState,
} from '@/app/dev/_fixtures/project-setup-project'
import type { ParticipantsClient } from '@/lib/projects/participants-client'
import { ProjectStep } from './project-step'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function renderStep(state: ProjectStepState, overrides: { client?: ParticipantsClient; onDecide?: () => Promise<boolean> } = {}) {
  const fixture = PROJECT_STEP_FIXTURES[state]
  const onNext = vi.fn()
  const onDecide = vi.fn(overrides.onDecide ?? (async () => true))
  const client = overrides.client ?? createFixtureParticipantsClient(state)
  render(
    <ProjectStep
      view={fixture.view}
      projectId={fixture.view.projectId}
      busy={false}
      canDecide={fixture.view.canDecide}
      canUpload
      uploading={false}
      onDecide={onDecide}
      onFiles={vi.fn()}
      onReread={vi.fn()}
      onNext={onNext}
      onGoTo={vi.fn()}
      client={client}
    />
  )
  return { onNext, onDecide, client }
}

const people = () => screen.getAllByTestId('project-step-person')

describe('ProjectStep', () => {
  beforeEach(() => {
    // The address search: no geocoder configured.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: false, results: [] })))
  })
  afterEach(() => vi.unstubAllGlobals())

  test('shows what the dialog took: name, status with its period, address with Gemeinde and Bundesland, description', async () => {
    renderStep('fresh')
    expect(await screen.findByTestId('project-step-name')).toHaveTextContent('Aufstockung Lacknergasse')
    expect(screen.getByTestId('project-step-status')).toHaveTextContent(/Active · since Oct 2026/)
    expect(screen.getByTestId('project-step-address')).toHaveTextContent('Lacknergasse 12, 1170 Wien')
    expect(screen.getByTestId('project-step-place')).toHaveTextContent('Wien · Wien')
    expect(screen.getByTestId('project-step-description')).toHaveTextContent(/Aufstockung eines Gründerzeithauses/)
    expect(screen.getByRole('link', { name: 'Change in the overview' })).toHaveAttribute('href', `/app/projects/${PROJECT_STEP_FIXTURES.fresh.view.projectId}`)
  })

  test('a past project read for reference says it closes after the review, with its period', async () => {
    renderStep('closing')
    expect(await screen.findByTestId('project-step-status')).toHaveTextContent(/Completed, closes after the review · Mar 2019 – Aug 2022/)
  })

  test('the description is changed through the review’s decisions, as the person’s answer', async () => {
    const user = userEvent.setup()
    const { onDecide } = renderStep('fresh')
    await user.click(await screen.findByRole('button', { name: 'Change' }))
    const description = screen.getByLabelText('Short project description')
    await user.clear(description)
    await user.type(description, 'Zubau eines Stiegenhauses')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onDecide).toHaveBeenCalledWith([{ key: 'kontext_beschreibung', action: 'answer', value: 'Zubau eines Stiegenhauses' }])
    await waitFor(() => expect(screen.queryByTestId('project-step-facts-form')).not.toBeInTheDocument())
  })

  test('the creator is already in, marked as the reader, with a role they cannot change here', async () => {
    renderStep('fresh')
    await waitFor(() => expect(people()).toHaveLength(1))
    const me = people()[0]
    expect(within(me).getByText('You')).toBeInTheDocument()
    expect(within(me).getByTestId('project-step-role')).toHaveTextContent('Admin')
    expect(within(me).queryByRole('combobox')).not.toBeInTheDocument()
  })

  test('adds a colleague from the office with a role and a Funktion', async () => {
    const user = userEvent.setup()
    const { client } = renderStep('fresh')
    const setRole = vi.spyOn(client, 'setRole')
    const savePerson = vi.spyOn(client, 'savePerson')
    await user.click(await screen.findByRole('button', { name: 'Add from the office' }))
    await user.click(screen.getByRole('combobox', { name: 'Person from the office' }))
    await user.click(await screen.findByRole('option', { name: /Sophie Hartl/ }))
    await user.click(screen.getByRole('button', { name: 'Structural engineering' }))
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(setRole).toHaveBeenCalledWith(PROJECT_STEP_FIXTURES.fresh.view.projectId, 'om-user-sh', 'project-editor')
    expect(savePerson).toHaveBeenCalledWith(
      PROJECT_STEP_FIXTURES.fresh.view.projectId,
      expect.objectContaining({ name: 'Sophie Hartl', function: 'Structural engineering', userId: 'user-sh' }),
      null
    )
    await waitFor(() => expect(people()).toHaveLength(2))
    expect(people()[1]).toHaveTextContent(/Sophie Hartl.*Office.*Structural engineering/)
    expect(within(people()[1]).getByRole('combobox', { name: "Sophie Hartl's role in the project" })).toHaveTextContent('Editor')
  })

  test('adds an external person without a Piloti account, with a Funktion and a company', async () => {
    const user = userEvent.setup()
    renderStep('fresh')
    await user.click(await screen.findByRole('button', { name: 'Add external person' }))
    await user.type(screen.getByLabelText('Name'), 'DI Paul Gruber')
    await user.type(screen.getByLabelText('Function in the project'), 'Bauphysik')
    await user.type(screen.getByLabelText('Company'), 'Gruber Bauphysik OG')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(people()).toHaveLength(2))
    expect(people()[1]).toHaveAttribute('data-kind', 'added')
    expect(people()[1]).toHaveTextContent(/DI Paul Gruber.*External.*Bauphysik · Gruber Bauphysik OG/)
  })

  test('taking a colleague off the project asks first and keeps them as a former member', async () => {
    const user = userEvent.setup()
    renderStep('team')
    await user.click(await screen.findByRole('combobox', { name: "Andreas Berger's role in the project" }))
    await user.click(await screen.findByRole('option', { name: 'Remove from project' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove Andreas Berger from the project?')
    await user.click(within(dialog).getByRole('button', { name: 'Remove from project' }))
    await waitFor(() => expect(screen.getByText('Andreas Berger').closest('li')).toHaveAttribute('data-kind', 'former'))
  })

  test('a refusal for the last admin is named', async () => {
    const { toast } = await import('sonner')
    const user = userEvent.setup()
    const client = createFixtureParticipantsClient('team')
    const { ParticipantsRequestError } = await import('@/lib/projects/participants-client')
    vi.spyOn(client, 'setRole').mockRejectedValue(new ParticipantsRequestError(409, 'keep one', 'last-admin'))
    renderStep('team', { client })
    await user.click(await screen.findByRole('combobox', { name: "Andreas Berger's role in the project" }))
    await user.click(await screen.findByRole('option', { name: 'Viewer' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/at least one person with the Admin role/)))
  })

  test('a reader who may neither edit nor manage sees everyone and is offered nothing', async () => {
    renderStep('viewer')
    await waitFor(() => expect(people()).toHaveLength(6))
    expect(screen.queryByRole('button', { name: 'Add external person' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add from the office' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.getByText(/People can be added by whoever may edit the project/)).toBeInTheDocument()
  })

  test('says so when the people cannot be read, and the way on stays', async () => {
    const user = userEvent.setup()
    const client = createFixtureParticipantsClient('fresh')
    vi.spyOn(client, 'steckbrief').mockRejectedValue(new Error('down'))
    const { onNext } = renderStep('fresh', { client })
    expect(await screen.findByText('The people could not be loaded.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Continue to filing/ }))
    expect(onNext).toHaveBeenCalledOnce()
  })
})
