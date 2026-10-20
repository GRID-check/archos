/**
 * Step 1, Projekt: what the dialog took, shown in one card and edited in a
 * sheet through the profile's door, and the Beteiligte in the other card,
 * colleagues with a role and externals with a Funktion, against the preview's
 * in-memory client. „Weiter zur Ablage" is always there, in the frame's footer.
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
import type { ComponentProps } from 'react'
import { SetupFooter, StepFooterProvider, useStepFooterChannel } from '../setup-frame'
import { ProjectStep } from './project-step'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function renderStep(state: ProjectStepState, overrides: { client?: ParticipantsClient; onDecide?: () => Promise<boolean> } = {}) {
  const fixture = PROJECT_STEP_FIXTURES[state]
  const onNext = vi.fn()
  const onDecide = vi.fn(overrides.onDecide ?? (async () => true))
  const client = overrides.client ?? createFixtureParticipantsClient(state)
  render(
    <Framed
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

/** The step inside the frame's footer channel, so its one action is where a person finds it. */
function Framed(props: ComponentProps<typeof ProjectStep>) {
  const { channel, progress, ownsPrimary, slotRef } = useStepFooterChannel()
  return (
    <StepFooterProvider value={channel}>
      <ProjectStep {...props} />
      <SetupFooter step="project" progress={progress} ownsPrimary={ownsPrimary} slotRef={slotRef} />
    </StepFooterProvider>
  )
}

const people = () => screen.getAllByTestId('project-step-person')

describe('ProjectStep', () => {
  beforeEach(() => {
    // The address search: no geocoder configured.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: false, results: [] })))
  })
  afterEach(() => vi.unstubAllGlobals())

  test('shows what the dialog took in one card: name, address with Gemeinde and Bundesland, status with its period, description', async () => {
    renderStep('fresh')
    const card = await screen.findByRole('region', { name: 'Project' })
    expect(await within(card).findByTestId('project-step-name')).toHaveTextContent('Aufstockung Lacknergasse')
    expect(within(card).getByTestId('project-step-status')).toHaveTextContent(/Ongoing · since Oct 2026/)
    expect(within(card).getByTestId('project-step-address')).toHaveTextContent('Lacknergasse 12, 1170 Wien')
    expect(within(card).getByTestId('project-step-place')).toHaveTextContent(/^Wien$/) // Gemeinde and Bundesland are one: said once
    expect(within(card).getByTestId('project-step-description')).toHaveTextContent(/Aufstockung eines Gründerzeithauses/)
  })

  test('a past project read for reference says it closes after the review, with its period', async () => {
    renderStep('closing')
    await waitFor(() => expect(screen.getByTestId('project-step-status')).toHaveTextContent(/Completed, closes after the review · Mar 2019 – Aug 2022/))
  })

  test('the description is changed in a sheet, through the review’s decisions, as the person’s answer', async () => {
    const user = userEvent.setup()
    const { onDecide } = renderStep('fresh')
    await user.click(await screen.findByRole('button', { name: 'Edit project' }))
    const sheet = await screen.findByRole('dialog', { name: 'Edit project' })
    expect(within(sheet).getByRole('link', { name: 'Go to the project overview' })).toHaveAttribute('href', `/app/projects/${PROJECT_STEP_FIXTURES.fresh.view.projectId}`)
    const description = within(sheet).getByLabelText('Short project description')
    await user.clear(description)
    await user.type(description, 'Zubau eines Stiegenhauses')
    await user.click(within(sheet).getByRole('button', { name: 'Save' }))
    expect(onDecide).toHaveBeenCalledWith([{ key: 'context_description', action: 'answer', value: 'Zubau eines Stiegenhauses' }])
    await waitFor(() => expect(screen.queryByTestId('project-step-facts-form')).not.toBeInTheDocument())
  })

  test('the creator is already in, marked as the reader, with a role they cannot change here', async () => {
    renderStep('fresh')
    await waitFor(() => expect(people()).toHaveLength(1))
    const me = people()[0]
    expect(within(me).getByText('You')).toBeInTheDocument()
    expect(within(me).getByTestId('project-step-role')).toHaveTextContent('Admin')
    expect(within(me).queryByRole('button', { name: /role in the project/ })).not.toBeInTheDocument()
  })

  test('adds a colleague from the office with a role and a Funktion', async () => {
    const user = userEvent.setup()
    const { client } = renderStep('fresh')
    const setRole = vi.spyOn(client, 'setRole')
    const savePerson = vi.spyOn(client, 'savePerson')
    await user.click(await screen.findByRole('button', { name: 'Colleague' }))
    const sheet = await screen.findByRole('dialog', { name: 'Colleague from the office' })
    await user.click(within(sheet).getByRole('combobox', { name: 'Person from the office' }))
    await user.click(await screen.findByRole('option', { name: /Sophie Hartl/ }))
    await user.click(within(sheet).getByRole('button', { name: 'Structural engineering' }))
    await user.click(within(sheet).getByRole('button', { name: 'Add' }))

    expect(setRole).toHaveBeenCalledWith(PROJECT_STEP_FIXTURES.fresh.view.projectId, 'om-user-sh', 'project-editor')
    expect(savePerson).toHaveBeenCalledWith(
      PROJECT_STEP_FIXTURES.fresh.view.projectId,
      expect.objectContaining({ name: 'Sophie Hartl', function: 'Structural engineering', userId: 'user-sh' }),
      null
    )
    await waitFor(() => expect(people()).toHaveLength(2))
    expect(people()[1]).toHaveTextContent(/Sophie Hartl.*Structural engineering · Editor/)
    expect(within(people()[1]).getByRole('button', { name: "Sophie Hartl's role in the project" })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('adds an external person without a Piloti account, with a Funktion and a company', async () => {
    const user = userEvent.setup()
    renderStep('fresh')
    await user.click(await screen.findByRole('button', { name: 'External person' }))
    const sheet = await screen.findByRole('dialog', { name: 'External person' })
    await user.type(within(sheet).getByLabelText('Name'), 'DI Paul Gruber')
    await user.type(within(sheet).getByLabelText('Function in the project'), 'Bauphysik')
    await user.type(within(sheet).getByLabelText('Company'), 'Gruber Bauphysik OG')
    await user.click(within(sheet).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(people()).toHaveLength(2))
    expect(people()[1]).toHaveAttribute('data-kind', 'added')
    expect(people()[1]).toHaveTextContent(/DI Paul Gruber.*External.*Bauphysik · Gruber Bauphysik OG/)
  })

  test('former members are folded under the list and not counted', async () => {
    const user = userEvent.setup()
    renderStep('team')
    await waitFor(() => expect(people()).toHaveLength(5))
    expect(screen.getByTestId('project-step-people-count')).toHaveTextContent('5')
    await user.click(screen.getByRole('button', { name: '1 former member' }))
    expect(people()).toHaveLength(6)
    expect(people()[5]).toHaveAttribute('data-kind', 'former')
  })

  test('taking a colleague off the project asks first and keeps them as a former member', async () => {
    const user = userEvent.setup()
    renderStep('team')
    await user.click(await screen.findByRole('button', { name: "Andreas Berger's role in the project" }))
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from project' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove Andreas Berger from the project?')
    await user.click(within(dialog).getByRole('button', { name: 'Remove from project' }))
    await user.click(await screen.findByRole('button', { name: '2 former members' }))
    await waitFor(() => expect(screen.getByText('Andreas Berger').closest('li')).toHaveAttribute('data-kind', 'former'))
  })

  test('a refusal for the last admin is named', async () => {
    const { toast } = await import('sonner')
    const user = userEvent.setup()
    const client = createFixtureParticipantsClient('team')
    const { ParticipantsRequestError } = await import('@/lib/projects/participants-client')
    vi.spyOn(client, 'setRole').mockRejectedValue(new ParticipantsRequestError(409, 'keep one', 'last-admin'))
    renderStep('team', { client })
    await user.click(await screen.findByRole('button', { name: "Andreas Berger's role in the project" }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Viewer' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/at least one person with the Admin role/)))
  })

  test('a reader who may neither edit nor manage sees everyone and is offered nothing', async () => {
    renderStep('viewer')
    await waitFor(() => expect(people()).toHaveLength(5))
    expect(screen.queryByRole('button', { name: 'External person' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Colleague' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit project' })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: /role in the project|^Edit / })).toHaveLength(0)
    expect(screen.getByText(/People can be added by whoever may edit the project/)).toBeInTheDocument()
  })

  test('says so when the people cannot be read, and the footer’s way on stays', async () => {
    const user = userEvent.setup()
    const client = createFixtureParticipantsClient('fresh')
    vi.spyOn(client, 'peopleRecord').mockRejectedValue(new Error('down'))
    const { onNext } = renderStep('fresh', { client })
    expect(await screen.findByText('The people could not be loaded.')).toBeInTheDocument()
    const footer = screen.getByTestId('intake-setup-footer')
    await user.click(within(footer).getByRole('button', { name: /Continue to filing/ }))
    expect(onNext).toHaveBeenCalledOnce()
  })
})
