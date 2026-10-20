'use client'

/**
 * What step 1 reads beyond the intake view: the project's name and status, the
 * Steckbrief's people and, for whoever may manage the members, the roster with
 * its roles. Three independent reads in parallel; one failing never hides what
 * the others answered, and `reload` reads again after a write.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ParticipantsClient, ProjectBasics, ProjectRoster } from '@/lib/projects/participants-client'
import type { SteckbriefView } from '@/lib/projects/steckbrief-types'

export interface ParticipantsState {
  /** Still reading for the first time. */
  loading: boolean
  project: ProjectBasics | null
  peopleRecord: SteckbriefView | null
  /** Null while loading, when it failed, or when the reader may not manage the members. */
  roster: ProjectRoster | null
  reload: () => Promise<void>
}

export function useParticipants(projectId: string, client: ParticipantsClient): ParticipantsState {
  const [state, setState] = useState<Omit<ParticipantsState, 'reload'>>({
    loading: true,
    project: null,
    peopleRecord: null,
    roster: null,
  })
  const generation = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    const [project, peopleRecord, roster] = await Promise.allSettled([
      client.project(projectId),
      client.peopleRecord(projectId),
      client.roster(projectId),
    ])
    // A slower earlier read never lands over a later one.
    if (mine !== generation.current) return
    setState((current) => ({
      loading: false,
      project: project.status === 'fulfilled' ? project.value : current.project,
      peopleRecord: peopleRecord.status === 'fulfilled' ? peopleRecord.value : current.peopleRecord,
      roster: roster.status === 'fulfilled' ? roster.value : current.roster,
    }))
  }, [client, projectId])

  useEffect(() => {
    void reload()
  }, [reload])

  return { ...state, reload }
}
