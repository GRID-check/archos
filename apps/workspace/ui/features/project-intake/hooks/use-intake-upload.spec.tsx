/**
 * Filing from the setup page is Dateien's own upload at the project root; the
 * only thing added is taking the folder dropped on the create dialog.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handOverDroppedFiles, takeDroppedFiles } from '@/features/documents/lib/dropped-file-handover'
import { useIntakeUpload } from './use-intake-upload'

const tree = vi.hoisted(() => ({ isLoading: false, error: false, folders: [], load: vi.fn() }))
const handleUpload = vi.hoisted(() => vi.fn())
vi.mock('@/features/documents/hooks/use-folder-tree', () => ({ useFolderTree: () => tree }))
vi.mock('@/features/documents/hooks/use-project-documents', () => ({ useProjectDocuments: () => ({ uploadFiles: vi.fn() }) }))
vi.mock('@/features/documents/hooks/use-shelf-upload', () => ({
  useShelfUpload: () => ({ handleUpload, decision: {} }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const file = new File(['%PDF'], 'EG.pdf')
const KEY = 'new-project:11111111-1111-4111-8111-111111111111'
const OTHER = 'new-project:22222222-2222-4222-8222-222222222222'
const options = { projectId: 'p1', collectionName: 'proj_1', onSettled: vi.fn() }

describe('useIntakeUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tree.isLoading = false
    takeDroppedFiles(KEY)
    takeDroppedFiles(OTHER)
  })

  it('files the folder dropped on the create dialog once the folders are known', () => {
    handOverDroppedFiles(KEY, [file])
    renderHook(() => useIntakeUpload({ ...options, dropKey: KEY }))
    expect(handleUpload).toHaveBeenCalledWith([file])
    expect(takeDroppedFiles(KEY)).toEqual([])
  })

  it('waits for the folders: a dropped tree is planned against them', () => {
    tree.isLoading = true
    handOverDroppedFiles(KEY, [file])
    renderHook(() => useIntakeUpload({ ...options, dropKey: KEY }))
    expect(handleUpload).not.toHaveBeenCalled()
    expect(takeDroppedFiles(KEY)).toEqual([file])
  })

  it('leaves a drop held under another key alone: it is another project\'s', () => {
    handOverDroppedFiles(OTHER, [file])
    renderHook(() => useIntakeUpload({ ...options, dropKey: KEY }))
    expect(handleUpload).not.toHaveBeenCalled()
    expect(takeDroppedFiles(OTHER)).toEqual([file])
  })

  it('takes nothing without a key, even while a drop is held', () => {
    handOverDroppedFiles(KEY, [file])
    renderHook(() => useIntakeUpload({ ...options, dropKey: null }))
    expect(handleUpload).not.toHaveBeenCalled()
    expect(takeDroppedFiles(KEY)).toEqual([file])
  })

  it('sends only real files on', () => {
    const { result } = renderHook(() => useIntakeUpload({ ...options, dropKey: null }))
    result.current.send([])
    expect(handleUpload).not.toHaveBeenCalled()
    result.current.send([file])
    expect(handleUpload).toHaveBeenCalledWith([file], { info: undefined })
  })

  it('passes on what a drop could not read, even when it read nothing, so the reader is told', () => {
    const { result } = renderHook(() => useIntakeUpload({ ...options, dropKey: null }))
    const info = { truncated: false, unreadable: 2 }
    result.current.send([], info)
    expect(handleUpload).toHaveBeenCalledWith([], { info })
  })
})
