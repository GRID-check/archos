/**
 * @vitest-environment node
 */
/**
 * The assignments' typed client (ADR-0055): the one place the browser writes
 * their paths and verbs. The Zuständige picker, a document's assignee strip
 * and the Anmerkung composer go through it, so a path or a verb the routes
 * change cannot be missed in one of three raw fetches.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assignPerson, listAssignees, listAssignmentCandidates, releasePerson } from './client'

const ANNA = { userId: 'user_anna', name: 'Anna Berger', email: null, profilePictureUrl: null }

const recorder = (body: unknown, status = 200) => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const run = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    return Response.json(body, { status })
  })
  return { run, calls }
}

describe('the assignments client', () => {
  it('reads who is assigned, assigns and releases on the resource’s own path', async () => {
    const { run, calls } = recorder({ assignees: [ANNA] })

    expect(await listAssignees('document', 'doc 1', run)).toEqual([ANNA])
    expect(await assignPerson('document', 'doc 1', 'user_anna', run)).toEqual([ANNA])
    expect(await releasePerson('document', 'doc 1', 'user_anna', run)).toEqual([ANNA])

    expect(calls).toEqual([
      { path: '/api/assignments/document/doc%201', method: 'GET', body: null },
      { path: '/api/assignments/document/doc%201', method: 'POST', body: { userId: 'user_anna' } },
      { path: '/api/assignments/document/doc%201?userId=user_anna', method: 'DELETE', body: null },
    ])
  })

  it('reads the candidates beside them', async () => {
    const { run, calls } = recorder({ candidates: [ANNA] })

    expect(await listAssignmentCandidates('document', 'doc_1', {}, run)).toEqual([ANNA])
    // A mark's Zuständige must answer it: the picker asks who may write the document.
    expect(await listAssignmentCandidates('document', 'doc_1', { access: 'write' }, run)).toEqual([ANNA])
    expect(calls.map((call) => call.path)).toEqual([
      '/api/assignments/document/doc_1/candidates',
      '/api/assignments/document/doc_1/candidates?access=write',
    ])
  })

  it('throws on a refusal: a failed read is not „nobody is assigned"', async () => {
    const { run } = recorder({ error: 'Forbidden' }, 403)

    await expect(listAssignees('document', 'doc_1', run)).rejects.toThrow()
    await expect(assignPerson('document', 'doc_1', 'user_anna', run)).rejects.toThrow()
    await expect(listAssignmentCandidates('document', 'doc_1', {}, run)).rejects.toThrow()
  })
})

/** Every browser-side source file under these roots, specs left out. */
function sources(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : []
  })
}

describe('the browser reaches the assignments through their client only', () => {
  it('names no /api/assignments path outside lib/assignments/client.ts', () => {
    const src = join(process.cwd(), 'src')
    const offenders = ['features', 'components', 'hooks', 'adapters']
      .flatMap((root) => sources(join(src, root)))
      .filter((path) => readFileSync(path, 'utf8').includes('/api/assignments'))
      .map((path) => path.slice(src.length + 1))
    expect(offenders).toEqual([])
  })
})
