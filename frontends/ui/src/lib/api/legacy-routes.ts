/**
 * API paths that were renamed to English, and where each used to live.
 *
 * `next.config.ts` turns every entry into a permanent redirect (308 keeps the method, the body and
 * the query string), so a browser tab opened before the deploy keeps working. Remove an entry one
 * release after the rename shipped.
 */
export interface LegacyRoute {
  /** The old path, with Next's `:param` segments. */
  from: string
  /** The new path, with the same segments. */
  to: string
}

export const LEGACY_ROUTES: readonly LegacyRoute[] = [
  { from: '/api/documents/:id/fassung', to: '/api/documents/:id/revision' },
  { from: '/api/documents/:id/fassung-compare', to: '/api/documents/:id/revision-compare' },
  { from: '/api/documents/fassung-candidates', to: '/api/documents/revision-candidates' },
  // Redirects run before next.config's `/api/archiv/*` rewrite, so the office shelf's old path
  // needs its own entry.
  { from: '/api/archiv/documents/fassung-candidates', to: '/api/office-shelf/documents/revision-candidates' },
  { from: '/api/office-shelf/documents/fassung-candidates', to: '/api/office-shelf/documents/revision-candidates' },
  { from: '/api/projects/:id/steckbrief', to: '/api/projects/:id/project-record' },
  // ADR-0131: a task is the definition, a task run one attempt. The definitions lived at `/jobs` and
  // the runs at `/tasks`; they now live at `/tasks` and `/runs`. The old run list (`GET /tasks`) is the
  // one path that cannot redirect, because it is the new task list.
  { from: '/api/projects/:id/jobs', to: '/api/projects/:id/tasks' },
  { from: '/api/projects/:id/jobs/:taskId', to: '/api/projects/:id/tasks/:taskId' },
  { from: '/api/projects/:id/jobs/:taskId/run', to: '/api/projects/:id/tasks/:taskId/run' },
  { from: '/api/projects/:id/jobs/:taskId/runs', to: '/api/projects/:id/runs?taskId=:taskId' },
  { from: '/api/projects/:id/tasks/:runId/review', to: '/api/projects/:id/runs/:runId/review' },
]
