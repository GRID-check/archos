/**
 * MSW handlers for one shelf of the `/api/documents` routes (ADR-0131 rule 5):
 * the project's and the office shelf's requests share a path and differ by
 * `scope` (`?scope=office_shelf`, or `scope` in the JSON body). A handler for
 * the other shelf passes the request on to the next handler.
 */

import { http, type DefaultBodyType, type HttpResponseResolver, type PathParams } from 'msw'

type Shelf = 'project' | 'office_shelf'
type Resolver = HttpResponseResolver<PathParams, DefaultBodyType, DefaultBodyType>

async function shelfOf(request: Request): Promise<Shelf> {
  if (new URL(request.url).searchParams.get('scope') === 'office_shelf') return 'office_shelf'
  if (request.method === 'GET' || request.method === 'DELETE') return 'project'
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null)
  return typeof body === 'object' && body !== null && (body as { scope?: unknown }).scope === 'office_shelf'
    ? 'office_shelf'
    : 'project'
}

function onShelf(shelf: Shelf, resolver: Resolver): Resolver {
  return async (info) => ((await shelfOf(info.request)) === shelf ? resolver(info) : undefined)
}

export const shelfGet = (shelf: Shelf, path: string, resolver: Resolver) => http.get(path, onShelf(shelf, resolver))
export const shelfPost = (shelf: Shelf, path: string, resolver: Resolver) => http.post(path, onShelf(shelf, resolver))
