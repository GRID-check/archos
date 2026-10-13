'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { UploadTray } from '@/features/documents/components/upload-tray'
import type { TrackedFile } from '@/features/documents/types'

/**
 * One batch played from drop to settled, above a stand-in listing, so the
 * tray's transitions can be watched (and recorded) the way the workspace shows
 * them: queued → sending → read → settled → retired.
 *
 * Two uploads at a time, like the real concurrency limit. The bytes move at a
 * fixed simulated rate; reading takes a few seconds per file; one file ends
 * held back and one fails, so the batch settles with something to act on. A
 * clean run (`?clean=1`) settles green and retires itself after six seconds.
 */

const MB = 1_000_000
const TICK_MS = 100
const BYTES_PER_TICK = 0.35 * MB
const CONCURRENCY = 2

interface Plan {
  id: string
  fileName: string
  fileSize: number
  readTicks: number
  ends: 'success' | 'held' | 'failed' | 'stored'
}

const HELD_REASON =
  'quarantined:{"reasons":[{"kind":"term","term":"Honorarvereinbarung","pages":[1,3]}],"checked":"full"}'

function plans(clean: boolean): Plan[] {
  return [
    { id: 'r1', fileName: 'Brandschutzkonzept_Wohnbau-Nord.pdf', fileSize: 4.8 * MB, readTicks: 30, ends: 'success' },
    { id: 'r2', fileName: 'Fluchtwegplan_EG-2OG.pdf', fileSize: 1.2 * MB, readTicks: 22, ends: 'success' },
    {
      id: 'r3',
      fileName: 'Honorarvereinbarung_Wohnbau-Nord.pdf',
      fileSize: 0.4 * MB,
      readTicks: 18,
      ends: clean ? 'success' : 'held',
    },
    { id: 'r4', fileName: 'Statik_Positionsplan.pdf', fileSize: 2.9 * MB, readTicks: 40, ends: clean ? 'success' : 'failed' },
    { id: 'r5', fileName: 'Lageplan_Bestand.pdf', fileSize: 1.1 * MB, readTicks: 26, ends: 'success' },
  ]
}

interface Running extends TrackedFile {
  readLeft: number
}

function start(clean: boolean): Running[] {
  return plans(clean).map((plan) => ({
    id: plan.id,
    fileName: plan.fileName,
    fileSize: plan.fileSize,
    collectionName: 'proj-1',
    status: 'uploading',
    progress: 0,
    bytesUploaded: 0,
    readLeft: plan.readTicks,
  }))
}

function step(files: Running[], clean: boolean): Running[] {
  const ends = new Map(plans(clean).map((plan) => [plan.id, plan.ends]))
  let sending = files.filter((file) => file.status === 'uploading' && file.uploadStartedAt).length
  return files.map((file) => {
    if (file.status === 'uploading' && !file.uploadStartedAt) {
      if (sending >= CONCURRENCY) return file
      sending += 1
      return { ...file, uploadStartedAt: Date.now() }
    }
    if (file.status === 'uploading') {
      const bytesUploaded = Math.min(file.fileSize, (file.bytesUploaded ?? 0) + BYTES_PER_TICK)
      if (bytesUploaded < file.fileSize) return { ...file, bytesUploaded }
      return { ...file, bytesUploaded, status: 'ingesting', serverFileId: `doc-${file.id}`, jobId: 'job-1' }
    }
    if (file.status === 'ingesting') {
      if (file.readLeft > 1) return { ...file, readLeft: file.readLeft - 1 }
      const end = ends.get(file.id) ?? 'success'
      if (end === 'held') return { ...file, readLeft: 0, status: 'held', errorMessage: HELD_REASON }
      if (end === 'failed') {
        return { ...file, readLeft: 0, status: 'failed', errorMessage: 'Die Datei konnte nicht gelesen werden.' }
      }
      return { ...file, readLeft: 0, status: end }
    }
    return file
  })
}

export function LiveRun({ clean = false }: { clean?: boolean }) {
  const [files, setFiles] = useState<Running[]>(() => start(clean))
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const replay = useCallback(() => setFiles(start(clean)), [clean])

  useEffect(() => {
    timer.current = setInterval(() => setFiles((current) => step(current, clean)), TICK_MS)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [clean])

  const dismiss = useCallback((ids: string[]) => {
    setFiles((current) => current.filter((file) => !ids.includes(file.id)))
  }, [])
  const retry = useCallback((id: string) => {
    setFiles((current) =>
      current.map((file) =>
        file.id === id
          ? { ...file, status: 'uploading', bytesUploaded: 0, uploadStartedAt: undefined, errorMessage: null, readLeft: 20 }
          : file
      )
    )
  }, [])

  return (
    <div className="flex h-[560px] flex-col bg-background" data-testid="live-run">
      <div className="flex items-center justify-between border-b bg-card px-4 py-2">
        <span className="text-sm font-medium">03_Einreichung</span>
        <button type="button" className="text-xs underline" onClick={replay} data-testid="live-replay">
          Replay
        </button>
      </div>
      <UploadTray files={files} onRetry={retry} onCancel={(id) => dismiss([id])} onCancelAll={() => setFiles([])} onDismiss={dismiss} />
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {['Einreichplan_2_Regelgeschoss.pdf', 'Einreichplan_10_Dachgeschoss.pdf', 'Baubeschreibung.pdf', 'Energieausweis_alt.pdf'].map(
          (name) => (
            <li key={name} className="border-b px-4 py-3 text-sm">
              {name}
            </li>
          )
        )}
      </ul>
    </div>
  )
}
