/**
 * Where the Python backend is: the one resolution of its base URL.
 *
 * A leaf on purpose. `@/lib/backend-proxy` re-exports it, but that module pulls
 * `@workos-inc/authkit-nextjs`, which the session-less paths (the scheduler's
 * fire, the job client, their unit tests) must not load. Those import from
 * here. Nothing else may read `BACKEND_URL` (`backend-url.spec.ts`).
 */

/** The backend base URL, without a trailing slash. */
export function getBackendUrl(): string {
  const url = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
  return url.replace(/\/$/, '')
}
