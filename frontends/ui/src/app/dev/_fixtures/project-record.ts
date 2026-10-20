/**
 * A Steckbrief for the `/dev` previews, and the answers its routes give there:
 * two members (one already described), a former member, and an external
 * planner. Writes change the fixture, and a preview re-reads it with
 * `useDevProjectRecord`, so editing in the preview shows its result.
 */

import { useSyncExternalStore } from 'react'
import type { ProjectPersonView, ProjectRecordView } from '@/lib/projects/project-record-types'

export const DEV_PROJECT_RECORD: ProjectRecordView = {
  address: 'Mariahilfer Straße 88, 1070 Wien',
  startedOn: '2026-03',
  startedOnIsDefault: true,
  endedOn: null,
  people: [
    {
      id: 'person-mk',
      kind: 'member',
      userId: 'user-mk',
      name: 'Mag. arch. Martina Kogler',
      function: 'Projektleitung',
      company: null,
      startedOn: '2026-03',
      endedOn: null,
    },
    { id: null, kind: 'member', userId: 'user-ab', name: 'Andreas Berger', function: null, company: null, startedOn: '2026-04', endedOn: null },
    {
      id: 'person-1',
      kind: 'added',
      userId: null,
      name: 'DI Maria Huber',
      function: 'Statik',
      company: 'Huber ZT GmbH',
      startedOn: '2026-03',
      endedOn: null,
    },
    {
      id: 'person-ls',
      kind: 'former',
      userId: 'user-ls',
      name: 'Lukas Steiner',
      function: 'Einreichplanung',
      company: null,
      startedOn: '2026-03',
      endedOn: '2026-07',
    },
  ],
  rosterKnown: true,
  canEdit: true,
  canErase: true,
}

let current = DEV_PROJECT_RECORD
const listeners = new Set<() => void>()
const publish = (next: ProjectRecordView): void => {
  current = next
  for (const listener of listeners) listener()
}

/** The fixture as it stands after the preview's edits. */
export function useDevProjectRecord(): ProjectRecordView {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
    () => DEV_PROJECT_RECORD
  )
}

type PersonBody = Pick<ProjectPersonView, 'name' | 'function' | 'company' | 'startedOn' | 'endedOn' | 'userId'>

const orNull = (value: string | null): string | null => (value && value.trim().length > 0 ? value.trim() : null)

/** The Steckbrief routes of `projectId`, answered from the fixture; null for any other URL. */
export async function answerProjectRecord(projectId: string, url: string, init?: RequestInit): Promise<Response | null> {
  const base = `/api/projects/${projectId}`
  const method = init?.method ?? 'GET'
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
  if (url === `${base}/steckbrief` && method === 'GET') return Response.json(current)
  if (url === `${base}/steckbrief` && method === 'PUT') {
    publish({ ...current, startedOn: (body.startedOn as ProjectRecordView['startedOn']) ?? null, startedOnIsDefault: false })
    return Response.json({ startedOn: current.startedOn })
  }
  if (url === `${base}/people` && method === 'POST') {
    const person = body as unknown as PersonBody
    const fields = { ...person, function: orNull(person.function), company: orNull(person.company) }
    const existing = current.people.find((entry) => person.userId && entry.userId === person.userId)
    const people = existing
      ? current.people.map((entry) => (entry === existing ? { ...entry, ...fields, id: `person-${Date.now()}` } : entry))
      : [...current.people, { ...fields, id: `person-${Date.now()}`, kind: 'added' as const }]
    publish({ ...current, people })
    return Response.json({}, { status: 201 })
  }
  if (url.startsWith(`${base}/people/`)) {
    const id = url.slice(`${base}/people/`.length)
    if (method === 'DELETE') {
      publish({ ...current, people: current.people.filter((entry) => entry.id !== id) })
      return new Response(null, { status: 204 })
    }
    const person = body as unknown as PersonBody
    const fields = { ...person, function: orNull(person.function), company: orNull(person.company) }
    publish({ ...current, people: current.people.map((entry) => (entry.id === id ? { ...entry, ...fields } : entry)) })
    return Response.json({})
  }
  return null
}
