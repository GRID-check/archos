/**
 * @vitest-environment node
 *
 * The requests the document-roles client puts on the wire. A refused bind keeps
 * its envelope, because the field logs it; a refused read or removal keeps only
 * the status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import {
  bindDocumentRole,
  DocumentRoleRequestError,
  listDocumentRoles,
  unbindDocumentRole,
} from './document-roles-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const JSON_HEADERS = { 'Content-Type': 'application/json' }

describe('listDocumentRoles', () => {
  it('reads the roles of the project', async () => {
    const roles = [{ id: 'b-1', documentId: 'd-1', role: 'zoning_plan' }]
    fetchMock.mockResolvedValueOnce(Response.json({ roles }))

    await expect(listDocumentRoles('p-1')).resolves.toEqual(roles)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/document-roles')
  })

  it('reads a body without a list as no bindings', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(null))

    await expect(listDocumentRoles('p-1')).resolves.toEqual([])
  })

  it('throws the typed error with the status when the read is refused', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))

    await expect(listDocumentRoles('p-1')).rejects.toMatchObject({ status: 500 })
  })
})

describe('bindDocumentRole', () => {
  it('POSTs the document, role and building, and answers the bindings it displaced', async () => {
    const replaced = [{ id: 'b-0', documentId: 'd-0', role: 'zoning_plan' }]
    fetchMock.mockResolvedValueOnce(Response.json({ replaced }))

    const answer = await bindDocumentRole('p-1', {
      documentId: 'd-1',
      role: 'zoning_plan',
      scopeInstanceId: null,
    })

    expect(answer).toEqual({ replaced })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/document-roles', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ documentId: 'd-1', role: 'zoning_plan', scopeInstanceId: null }),
    })
  })

  it('answers no displaced bindings when the answer names none', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await expect(
      bindDocumentRole('p-1', { documentId: 'd-1', role: 'zoning_plan', scopeInstanceId: null }),
    ).resolves.toEqual({ replaced: [] })
  })

  it('keeps the refusal envelope, so the field can log what the server said', async () => {
    const envelope = { error: 'document is not in this project' }
    fetchMock.mockResolvedValueOnce(Response.json(envelope, { status: 422 }))

    const failure = await bindDocumentRole('p-1', {
      documentId: 'd-1',
      role: 'zoning_plan',
      scopeInstanceId: null,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DocumentRoleRequestError)
    expect(failure).toMatchObject({ status: 422, body: envelope })
  })

  it('keeps no body when the refusal is not an envelope', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 500 }))

    const failure = await bindDocumentRole('p-1', {
      documentId: 'd-1',
      role: 'zoning_plan',
      scopeInstanceId: null,
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ status: 500, body: null })
  })
})

describe('unbindDocumentRole', () => {
  it('DELETEs the binding under its id', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await unbindDocumentRole('p-1', 'b-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/document-roles/b-1', { method: 'DELETE' })
  })

  it('throws the typed error with the status when the removal is refused', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }))

    const failure = await unbindDocumentRole('p-1', 'b-1').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 404 })
  })
})
