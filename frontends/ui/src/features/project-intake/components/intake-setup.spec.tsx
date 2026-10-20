/**
 * The connected setup page: a project set up by hand says so, one Piloti sets
 * up is drawn in the five-step frame, and its documents are filed through the
 * project's own upload.
 */
import { render, screen, waitFor } from '@/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { INTAKE_WAITING } from '@/app/dev/_fixtures/project-intake'
import { IntakeSetup } from './intake-setup'

vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    fileUpload: {
      acceptedTypes: '.pdf',
      acceptedMimeTypes: ['application/pdf'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

const send = vi.fn()
const uploadHook = vi.hoisted(() => vi.fn())
vi.mock('../hooks/use-intake-upload', () => ({ useIntakeUpload: uploadHook }))

const decision = {
  open: false,
  setOpen: vi.fn(),
  plan: null,
  pending: false,
  kind: 'folder',
}

describe('IntakeSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    uploadHook.mockReturnValue({
      send,
      shelfUpload: {
        decision,
        applyFolderPlan: vi.fn(),
        onReleaseChange: vi.fn(),
        onRevisionChange: vi.fn(),
      },
      upload: {
        trackedFiles: [],
        isUploading: false,
        retryFile: vi.fn(),
        cancelFile: vi.fn(),
        cancelUpload: vi.fn(),
        dismissFiles: vi.fn(),
      },
    })
  })

  it('says a project without an intake has none, and links its briefing', () => {
    render(<IntakeSetup projectId="p1" collectionName="proj_1" initial={null} projectClosed={false} />)

    expect(screen.getByTestId('intake-none')).toHaveTextContent('This project has no setup by Piloti')
    expect(screen.getByRole('link', { name: 'Open the briefing' })).toHaveAttribute('href', '/app/projects/p1/intake')
  })

  it('files uploads into the project\'s collection, and takes only the drop the redirect named', () => {
    const key = 'new-project:11111111-1111-4111-8111-111111111111'
    render(<IntakeSetup projectId="p1" collectionName="proj_1" initial={INTAKE_WAITING} projectClosed={false} dropKey={key} />)

    expect(uploadHook).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', collectionName: 'proj_1', dropKey: key }))
  })

  it('takes no drop when the redirect named none', () => {
    render(<IntakeSetup projectId="p1" collectionName="proj_1" initial={INTAKE_WAITING} projectClosed={false} />)
    expect(uploadHook).toHaveBeenCalledWith(expect.objectContaining({ dropKey: null }))
  })

  it('draws the five-step frame with the project named, on the step the review points to', () => {
    render(
      <IntakeSetup
        projectId="p1"
        projectName="Wohnanlage Gartenstraße 12"
        collectionName="proj_1"
        initial={INTAKE_WAITING}
        projectClosed={false}
      />
    )

    expect(screen.getByTestId('intake-setup-head')).toHaveTextContent('Wohnanlage Gartenstraße 12')
    // No documents yet: the Ablage, where they go in.
    expect(screen.getByTestId('intake-setup')).toHaveAttribute('data-step', 'filing')
    expect(screen.getByRole('navigation', { name: 'Steps of the setup' })).toBeInTheDocument()
  })

  it('opens the step the address names', () => {
    window.history.replaceState(null, '', '/app/projects/p1/setup?step=profile')
    try {
      render(<IntakeSetup projectId="p1" collectionName="proj_1" initial={INTAKE_WAITING} projectClosed={false} />)
      expect(screen.getByTestId('intake-setup')).toHaveAttribute('data-step', 'profile')
    } finally {
      window.history.replaceState(null, '', '/')
    }
  })

  it('offers no upload on a closed project', async () => {
    render(<IntakeSetup projectId="p1" collectionName="proj_1" initial={INTAKE_WAITING} projectClosed />)
    await waitFor(() => expect(screen.getByTestId('intake-setup')).toBeInTheDocument())
    expect(screen.queryByTestId('intake-upload-zone')).toBeNull()
  })
})
