/**
 * Filing from the setup page is Dateien's own upload at the project root; the
 * only thing added is taking the folder dropped on the create dialog.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handOverDroppedFiles, NEW_PROJECT_DROP_KEY, takeDroppedFiles } from '@/features/documents/lib/dropped-file-handover'
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
const options = { projectId: 'p1', collectionName: 'proj_1', onSettled: vi.fn() }

describe('useIntakeUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tree.isLoading = false
    takeDroppedFiles(NEW_PROJECT_DROP_KEY)
  })

  it('files the folder dropped on the create dialog once the folders are known', () => {
    handOverDroppedFiles(NEW_PROJECT_DROP_KEY, [file])
    renderHook(() => useIntakeUpload({ ...options, takeNewProjectDrop: true }))
    expect(handleUpload).toHaveBeenCalledWith([file])
    expect(takeDroppedFiles(NEW_PROJECT_DROP_KEY)).toEqual([])
  })

  it('waits for the folders: a dropped tree is planned against them', () => {
    tree.isLoading = true
    handOverDroppedFiles(NEW_PROJECT_DROP_KEY, [file])
    renderHook(() => useIntakeUpload({ ...options, takeNewProjectDrop: true }))
    expect(handleUpload).not.toHaveBeenCalled()
    expect(takeDroppedFiles(NEW_PROJECT_DROP_KEY)).toEqual([file])
  })

  it('leaves that drop alone on a project that already has documents', () => {
    handOverDroppedFiles(NEW_PROJECT_DROP_KEY, [file])
    renderHook(() => useIntakeUpload({ ...options, takeNewProjectDrop: false }))
    expect(handleUpload).not.toHaveBeenCalled()
    expect(takeDroppedFiles(NEW_PROJECT_DROP_KEY)).toEqual([file])
  })

  it('sends only real files on', () => {
    const { result } = renderHook(() => useIntakeUpload({ ...options, takeNewProjectDrop: false }))
    result.current.send([])
    expect(handleUpload).not.toHaveBeenCalled()
    result.current.send([file])
    expect(handleUpload).toHaveBeenCalledWith([file], { info: undefined })
  })

  it('passes on what a drop could not read, even when it read nothing, so the reader is told', () => {
    const { result } = renderHook(() => useIntakeUpload({ ...options, takeNewProjectDrop: false }))
    const info = { truncated: false, unreadable: 2 }
    result.current.send([], info)
    expect(handleUpload).toHaveBeenCalledWith([], { info })
  })
})
