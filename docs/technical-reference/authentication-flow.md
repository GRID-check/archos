# Authentication Flow

Auth is handled by **WorkOS AuthKit v4** with session cookies. The `REQUIRE_AUTH` environment variable controls whether auth is enforced.

## Sign-in flow

1. A request for a protected page with no session reaches the Next.js proxy
   (`frontends/ui/src/proxy.ts`), which asks AuthKit. For an initial document
   navigation, AuthKit mints the PKCE verifier cookie and redirects to WorkOS in
   the same response.
2. A client-side (RSC) navigation or a client fetch cannot receive that cookie —
   AuthKit mints it only when answering a document request — so the proxy
   replaces the redirect with `/api/auth/signin?returnPathname=<page>`. That is a
   Route Handler, where `getSignInUrl()` may write the cookie whatever kind of
   request it answers, and the browser stores it on the way through.
   Without that hop the flow cannot finish: the client router turns a redirected
   RSC fetch it cannot decode into an MPA navigation to the redirect *target*
   (`doMpaNavigation(responseUrl)` in Next's `fetch-server-response.js`), so the
   browser lands on WorkOS and starts a flow that was never given a verifier.
3. The browser reaches the WorkOS hosted login, which returns to
   `/api/auth/callback` with `code` and `state`.
4. `handleAuth()` exchanges the code, verifying it against the PKCE cookie, and
   writes the encrypted httpOnly `wos-session` cookie, split into
   `wos-session.0`, `wos-session.1`, … when it is too large for one (below).
5. The callback redirects to the page the sign-in started for. AuthKit carries
   that page in the sealed flow state; the callback's own `returnPathname`
   (`/app/projects`) is the fallback.

The sign-in route serves every unauthenticated client navigation now, and each
one mints a verifier cookie that outlives its flow by ten minutes. `getSignInUrl`
holds AuthKit's budget of five (`MAX_PKCE_COOKIES`, authkit-nextjs 4.6.2),
expiring the older ones rather than letting a loop fill the cookie jar until the
request headers overflow.

A callback that arrives without its flow (`missing_pkce_cookie`,
`oauth_state_mismatch`) goes to `/auth/error?error=SessionExpired`, which offers
Try Again. AuthKit has already deleted the flow cookie by then, so reloading the
callback URL can never succeed. `/` sends a signed-out visitor to the landing
site, and to `/api/auth/signin` when `?sign-in` asks for the app.

Sign-out calls `signOut({ returnTo: '/' })` which clears the WorkOS session cookie.

## The session cookie, and why it is split

The sealed session holds the access token, and WorkOS puts every permission and
every feature flag the person has into that token. A browser keeps a cookie
only while its name and value fit in 4096 bytes and drops a larger one
silently. In October 2026 an admin of GRID Test in Staging held 18 permissions
and 33 flags, the cookie came to about 4,180 bytes, and every new browser
signed in, lost the cookie, and was sent back to WorkOS, which was still signed
in and sent it straight back: `ERR_TOO_MANY_REDIRECTS`, nothing in any log.
Older browsers kept working on the smaller cookie they had from before.

Neither claim can be removed. A JWT template adds claims, it does not drop the
built-in ones, and the WorkOS docs say enabling a flag "starts including it in
a user's access token"; the feature-flag runtime client evaluates flags without
the claim but does not stop WorkOS minting it (workos/authkit-nextjs#404, open).

So the cookie is split, the way Auth.js and `@supabase/ssr` keep theirs: a bun
patch on AuthKit (`frontends/ui/patches/@workos-inc%2Fauthkit-nextjs@4.6.2.patch`,
module `session-cookie.js`) reads and writes the session through every path
AuthKit has (the proxy's refresh, `saveSession`, `refreshSession` behind the
client's token refresh and `switchToOrganization`, the callback, sign-out). A
session that fits stays one cookie under its own name; one that does not
becomes chunks of 3,800 bytes, and every write expires the form it replaced.
`src/lib/auth/session-cookie-chunks.spec.ts` runs the installed package, so an
upgrade that leaves the patch behind fails there. When AuthKit is upgraded,
`bun install` refuses a patch that no longer applies: re-create it with
`bun patch @workos-inc/authkit-nextjs`, or delete it if upstream has closed #404.

## Switching organization

Someone who belongs to more than one organization finds „Switch organization"
in the avatar menu (`components/shell/organization-switcher.tsx`, a submenu of
`sidebar-user-menu.tsx`). The shell asks `switchableOrganizations` in
`lib/organizations/service.ts`, which lists the person's active WorkOS
memberships by name (cached five minutes, empty for one organization, so the
entry is not there). Picking one calls AuthKit's `switchToOrganization`,
which refreshes the session into the chosen organization, or sends the person
to sign in when that organization requires SSO or MFA, and then loads
`/app/projects` of the new office.

It is not WorkOS's `OrganizationSwitcher` widget. The widget mounts the first
Radix Theme on the page, and Radix gives a root Theme `min-height: 100dvh`: in
the header band it stretched the header to the height of the window. Its own
dropdown also cannot nest in our menu.

## Session resolution

`getGridSession()` in `frontends/ui/src/lib/auth/session.ts:38` reads the current session using `withAuth()` from AuthKit:

```typescript
export async function getGridSession(): Promise<GridSession | null>
```

It returns a `GridSession` with these fields:

| Field | Source |
|---|---|
| `userId` | `auth.user.id` (WorkOS sub claim) |
| `email` | `auth.user.email` |
| `name` | `firstName + lastName` or fallback |
| `accessToken` | `auth.accessToken` (raw WorkOS JWT) |
| `organizationId` | `auth.organizationId` from session |
| `orgMembershipId` | Resolved via `workos.userManagement.listOrganizationMemberships()` |
| `role` | `auth.role` or from JWT claims |
| `permissions` | `auth.permissions` (from WorkOS FGA) |

When no session exists, `getGridSession()` returns `null`.

## Auth guards

### requireGridSession()

`frontends/ui/src/lib/auth/session.ts`

Requires any valid session. Throws `SessionRequiredError` (`lib/api/errors`, an
`UnauthorizedError`) if no session is present.

### requireAuthorizedSession()

`frontends/ui/src/lib/auth/require-auth.ts`

Extends `requireGridSession()` and additionally requires an `organizationId`.
Without one it throws `NoOrganizationError` (a `ForbiddenError`); the page
variant, `requireAuthorizedPageSession()`, redirects to
`/app/onboarding/organization` instead. Returns `AuthorizedSession` (guarantees
`organizationId`, `orgMembershipId`, `role`, `permissions` are non-null).

### What a refusal is answered

Server code tells an authorization refusal by type: `isAuthzRefusal`
(`lib/api/errors`) is any `ApiError` with status 401, 403 or 404. The route
wrapper (`apiRoute`) answers both session guards `403 { error: 'Forbidden',
code: 'FORBIDDEN' }`, the answer they had while they were plain `Error`s
matched by message; HTTP would say 401 for no session, and moving to it is its
own decision. Every other `ApiError` is answered with its own status. The
client error boundary (`app/error.tsx`) still classifies by message, because a
server-thrown class does not survive the RSC boundary.

## Anonymous mode

When `REQUIRE_AUTH=false`:

- **Server-side**: `getGridSession()` still works (returns null if no cookie), but is not called by BFF routes. `resolveSession()` in the v1 proxy returns `null`. No Authorization headers are forwarded.
- **Client-side**: `useAuth()` in `frontends/ui/src/adapters/auth/use-auth.ts:73` short-circuits and returns `DEFAULT_USER`:

```typescript
{
  user: { id: 'default-user', name: 'Default User', email: null, image: null },
  isAuthenticated: true,
  authRequired: false,
  accessToken: undefined,
  idToken: undefined,
  organizationId: undefined,
}
```

- **WebSocket**: The `fetchCollectionScopeHeader` call in `server.js` proceeds without auth; the scope endpoint returns the scope header with null session identity.

## BFF auth forwarding

In auth mode, the Next.js BFF acts as an auth gateway. When proxying to the Python backend, it attaches:

| Header | Value | Routes |
|---|---|---|
| `Authorization` | `Bearer <accessToken>` | the `/websocket` upgrade, `/v1/*` |
| `X-Grid-Collection-Scope` | Base64url-encoded scope array | All proxied routes |
| `X-Grid-Organization-Id` | `session.organizationId` | WebSocket upgrade only |
| `X-Grid-User-Id` | `session.userId` | WebSocket upgrade only |

The `buildCollectionScopeFromRequest()` helper constructs the collection scope from the session's organization, project, and conversation IDs.

## Python JWT validation

`apps/backend/src/aiq_api/auth/workos_validator.py` creates a `JWTValidator` configured for WorkOS,
and the `aiq_api.validators` entry point in `apps/backend/pyproject.toml` hands it to the
middleware (ADR-0002: another package can register its own):

```python
JWTValidator(
    issuer_url=f"https://api.workos.com/user_management/{client_id}",
    jwks_uri=f"https://api.workos.com/sso/jwks/{client_id}",
    audience=None,  # AuthKit access tokens carry no `aud`
    algorithms=["RS256"],
    verify_iss=True,
)
```

`JWTValidator` (`apps/backend/src/aiq_api/auth/jwt_validator.py:39`) uses `PyJWT[cryptography]` to verify RS256 signatures:

1. Fetches JWKS from WorkOS (cached for 6 hours, cache-busted on kid miss)
2. Extracts the signing key matching the JWT `kid`
3. Verifies signature, `exp` and `iss`; `aud` only when an audience is configured, which the WorkOS validator does not
4. Returns a dict with claims (`type: "jwt"`, `sub`, `email`, `name`, `token`) on success
5. Returns error code `token_expired` or `token_invalid` on failure

The validated principal is accessible in Python via `get_current_principal()` from `packages/agent/src/aiq_agent/auth/utils.py`, which reads the caller identity the middleware binds in `aiq_agent.auth.request_identity`.

## Token retrieval chain

`get_auth_token()` in `packages/agent/src/aiq_agent/auth/utils.py` returns a token from the first available source, checked in priority order:

1. **Registered token fetchers** — custom fetchers registered via `register_token_fetcher(fn, priority)`, sorted high-to-low
2. **NAT Context cookies** — `idToken` cookie from the NAT context (browser / web-UI mode)
3. **NAT Context Authorization header** — `Authorization: Bearer <jwt>` from the NAT context (API callers)
4. Returns `None` if no source yields a token

## WebSocket auth

During WebSocket upgrade, `server.js:199` intercepts `/websocket` connections:

1. Calls `/api/auth/websocket-scope` (internal BFF endpoint)
2. This resolves the session via `getGridSession()`, checks project access, builds the collection scope
3. If auth is required and no session, returns 401/403 and the socket is rejected
4. On success, the response includes `organizationId`, `userId`, and `accessToken`
5. `server.js` forwards these as `X-Grid-Organization-Id`, `X-Grid-User-Id`, and `Authorization: Bearer <token>` to the Python backend's WebSocket route
6. The Python `/websocket` route checks these headers to identify the caller
