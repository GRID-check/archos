/**
 * The connected setup page: a project set up by hand says so, and one Piloti
 * sets up files its documents through the project's own upload.
 */
import { render, screen, waitFor } from '@/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { INTAKE_READY, INTAKE_WAITING } from '@/app/dev/_fixtures/project-intake'
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
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

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
        onFassungChange: vi.fn(),
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

  it('files uploads into the project\'s collection, and takes the create dialog\'s drop while it waits for documents', () => {
    render(<IntakeSetup projectId="p1" collectionName="proj_1" initial={INTAKE_WAITING} projectClosed={false} />)

    expect(uploadHook).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', collectionName: 'proj_1', takeNewProjectDrop: true })
    )
  })

  it('takes that drop only while the intake waits for its first documents', () => {
    render(<IntakeSetup projectId="p1" collectionName="proj_1" initial={INTAKE_READY} projectClosed={false} />)
    expect(uploadHook).toHaveBeenCalledWith(expect.objectContaining({ takeNewProjectDrop: false }))
  })

  it('offers no upload on a closed project', async () => {
    render(<IntakeSetup projectId="p1" collectionName="proj_1" initial={INTAKE_WAITING} projectClosed />)
    await waitFor(() => expect(screen.getByTestId('intake-setup')).toBeInTheDocument())
    expect(screen.queryByTestId('intake-upload-zone')).toBeNull()
  })
})
