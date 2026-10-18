/**
 * MSW handlers for the inbox reads a surface makes on mount.
 *
 * The review asks which of a document's marks have unread news
 * (`GET /api/inbox/unread-anchors`) as it opens. With MSW set to
 * `onUnhandledRequest: 'bypass'` that GET would reach `localhost` from every
 * spec that renders a review (see `user-preferences.ts`). Nothing is unread
 * by default; a spec that cares overrides this with `server.use(...)`.
 */

import { http, HttpResponse } from 'msw'

export const inboxHandlers = [http.get('/api/inbox/unread-anchors', () => HttpResponse.json({ anchorIds: [] }))]
