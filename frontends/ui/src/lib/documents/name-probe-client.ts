/**
 * The typed client for the name probe (ADR-0055): the one place the paths,
 * the verbs and the response parsing of "which of these names exist" live.
 *
 * The upload planner calls it; the route specs drive the real handlers through
 * it, so the client and the routes cannot disagree about a path or a field.
 * Responses are PARSED, not cast — see `lifecycle-client.ts` for why.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import {
  NAME_PROBE_MAX_NAMES,
  revisionCandidatesResponseSchema,
  nameProbeResponseSchema,
  type DocumentNameMatch,
  type RevisionCandidateMatch,
} from './name-probe-types'

export type NameProbeFetch = (path: string, init?: RequestInit) => Promise<Response>

/** A probe the API refused; the status says whether it is worth retrying. */
export class NameProbeError extends Error {
  constructor(readonly status: number) {
    super(`Name probe failed (${status})`)
    this.name = 'NameProbeError'
  }
}

export const PROJECT_NAME_PROBE_PATH = '/api/documents/name-matches'
export const OFFICE_SHELF_NAME_PROBE_PATH = '/api/archiv/documents/name-matches'
export const PROJECT_REVISION_CANDIDATES_PATH = '/api/documents/fassung-candidates'
export const OFFICE_SHELF_REVISION_CANDIDATES_PATH = '/api/archiv/documents/fassung-candidates'

export interface DocumentNameProbeClient {
  /** Matches on a project's shelf. */
  project: (projectId: string, names: readonly string[]) => Promise<DocumentNameMatch[]>
  /** Matches in the organization's Archiv. */
  officeShelf: (names: readonly string[]) => Promise<DocumentNameMatch[]>
  /**
   * What the names continue on a project's shelf: the documents they would be
   * the next Fassung of (ADR-0099). `landsIn` says where each name lands (the
   * existing folder, or the nearest existing one above a folder the upload
   * creates; null is the root), so only documents of the collection that
   * folder files into are offered (ADR-0087).
   */
  projectRevisions: (
    projectId: string,
    names: readonly string[],
    landsIn?: ReadonlyMap<string, string | null>,
  ) => Promise<RevisionCandidateMatch[]>
  /** What the names continue in the Archiv. */
  officeShelfRevisions: (names: readonly string[]) => Promise<RevisionCandidateMatch[]>
}

/**
 * The names in probes the route accepts: unique, non-empty, at most
 * {@link NAME_PROBE_MAX_NAMES} each. One POST with every name refused the whole
 * pick with a 400 past the cap, and nothing was uploaded.
 */
function chunks(names: readonly string[]): string[][] {
  const unique = [...new Set(names.filter((name) => name.length > 0))]
  const out: string[][] = []
  for (let start = 0; start < unique.length; start += NAME_PROBE_MAX_NAMES) {
    out.push(unique.slice(start, start + NAME_PROBE_MAX_NAMES))
  }
  return out
}

/** One document per id: a rename can match a name in one batch and the filename in another. */
function uniqueById(matches: readonly DocumentNameMatch[]): DocumentNameMatch[] {
  return [...new Map(matches.map((match) => [match.id, match])).values()]
}

export function createDocumentNameProbeClient(
  run: NameProbeFetch = (path, init) => fetch(path, init),
): DocumentNameProbeClient {
  const send = async (path: string, body: unknown): Promise<unknown> => {
    const response = await run(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new NameProbeError(response.status)
    return response.json()
  }
  const post = async (path: string, body: unknown): Promise<DocumentNameMatch[]> =>
    nameProbeResponseSchema.parse(await send(path, body)).documents
  const batched = async (path: string, names: readonly string[], extra: Record<string, unknown>) =>
    uniqueById((await Promise.all(chunks(names).map((batch) => post(path, { ...extra, names: batch })))).flat())
  /** One answer per dropped name: two batches never answer for the same name. */
  const candidates = async (
    path: string,
    names: readonly string[],
    extra: Record<string, unknown>,
    landsIn?: ReadonlyMap<string, string | null>
  ) => {
    /** Where the batch's names land, for the names the caller said; nothing when it said none. */
    const foldersOf = (batch: readonly string[]) =>
      landsIn
        ? { folders: Object.fromEntries(batch.filter((name) => landsIn.has(name)).map((name) => [name, landsIn.get(name) ?? null])) }
        : {}
    const answers = await Promise.all(
      chunks(names).map(async (batch) =>
        revisionCandidatesResponseSchema.parse(await send(path, { ...extra, names: batch, ...foldersOf(batch) })).candidates
      )
    )
    return [...new Map(answers.flat().map((candidate) => [candidate.name, candidate])).values()]
  }
  return {
    project: (projectId, names) => batched(PROJECT_NAME_PROBE_PATH, names, { projectId }),
    officeShelf: (names) => batched(OFFICE_SHELF_NAME_PROBE_PATH, names, {}),
    projectRevisions: (projectId, names, landsIn) => candidates(PROJECT_REVISION_CANDIDATES_PATH, names, { projectId }, landsIn),
    officeShelfRevisions: (names) => candidates(OFFICE_SHELF_REVISION_CANDIDATES_PATH, names, {}),
  }
}
