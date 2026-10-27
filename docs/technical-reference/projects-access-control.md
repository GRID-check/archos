# Project Access Control (WorkOS FGA)

Project-level authorization uses WorkOS Fine-Grained Authorization (FGA). Each project is registered as a WorkOS FGA resource, and access is checked on every request.

## Resource creation

When a project is created (via server action or API route), the flow is:

1. A `projects` row is inserted into PostgreSQL with a generated `collectionName` (`proj_{uuid}`).
2. A WorkOS FGA resource is created via `workos.authorization.createResource()` with `resourceTypeSlug: 'project'` and `externalId` set to the project's UUID.
3. The returned WorkOS resource ID is stored back in the `workosResourceId` column.
4. The creator is assigned the `project-admin` role via `workos.authorization.assignRole()`.

Source: `frontends/ui/src/app/projects/actions.ts:30`, `frontends/ui/src/app/api/projects/route.ts:52`

## Permission check (`requireProjectAccess`)

`frontends/ui/src/lib/authz/projects.ts`

```typescript
export async function requireProjectAccess(
  session: AuthorizedSession,
  projectId: string,
  permission: ProjectPermission | readonly ProjectPermission[] = "project:view",
  options?: { includeDeleted?: boolean; evenWhenClosed?: boolean },
): Promise<ProjectAccess> // { role, closed, readsBecauseClosed }
```

### Check flow

1. **Tenancy**: The project's `organizationId` is read from PostgreSQL. If the project does not exist, belongs to another organization, or is soft-deleted (unless `includeDeleted`), the function throws `"Not found"`. This runs for everyone, admins included.
2. **Closed project** (ADR-0090): a closed project keeps only the permissions it still allows; a request that asked only for writes is refused with a named reason.
3. **Org admin bypass**: a session whose token carries `org:projects:administer` returns `"project-admin"`. The permission decides, never the role name.
4. **Effective permissions**: one WorkOS call, `authorization.listEffectivePermissionsByExternalId`, with the session's `organizationMembershipId`, `resourceTypeSlug: "project"` and the project id as `externalId`. It counts roles assigned on the project and on its ancestors. Cached for `GRID_AUTHZ_CACHE_TTL_MS` (`effectiveResourcePermissions` in `lib/authz/resource-check.ts`); a failed lookup holds nothing and is not cached.
5. **Access and role**: holding any one requested permission grants access. The role is read from the same set:
   - `project:manage` → `"project-admin"`
   - any of `project:edit`, `project:documents:write`, `project:memory:write` → `"project-editor"`
   - otherwise → `"project-viewer"`

If the FGA check fails, the function throws `"Not found"` (not `"Forbidden"`) to avoid leaking information about project existence.

## Permission slugs

| Slug | Required for |
|------|-------------|
| `project:view` | Viewing project page, listing documents, project-scoped chat |
| `project:edit` | Uploading documents to a project |
| `project:manage` | Editing project name, managing members, deleting project |
| `project:chat` | Chatting within a project context (checked alongside `project:view`) |

## Where permissions are enforced

| Action | Route / Action | Permission |
|--------|---------------|------------|
| List projects | `GET /api/projects`, `page.tsx` | `project:view` per project (`projectsHolding`, the same cached effective permissions); closed projects listed for every member |
| View project | `GET /api/projects/[id]` | `project:view` |
| Edit project name | `PATCH /api/projects/[id]` | `project:manage` |
| Delete project | `DELETE /api/projects/[id]` | `project:manage` |
| List documents | `GET /api/documents?projectId=` | `project:view` (implicitly via project page) |
| Upload document | `POST /api/documents/upload` | `project:edit` |
| List members | `GET /api/projects/[id]/members` | `project:manage` |
| Add member | `POST /api/projects/[id]/members` | `project:manage` |
| Remove member | `DELETE /api/projects/[id]/members/[id]` | `project:manage` |
| V1 collection access | `validateCollectionName()` (`lib/proxy/collection-authz.ts`), per method | `project:documents:write` or `project:edit` (for `proj_*` collections); raw uploads and whole-collection deletes refused |
| WebSocket scope | `GET /api/auth/websocket-scope` | `project:view` |

## Owner assignment

The project creator is automatically assigned `project-admin` via `workos.authorization.assignRole()` in the same transaction that inserts the project. No additional setup is needed.

Source: `frontends/ui/src/app/projects/actions.ts:57`

## Project-org validation

Every project belongs to exactly one organization (the `organizationId` FK on the `projects` table). Access checks verify:

1. The project exists (DB lookup).
2. The project's `organizationId` matches `session.organizationId`.
3. If mismatch, throws `"Not found"` — the same error as a nonexistent project.

This prevents cross-org access even if an FGA check would pass (e.g., due to configuration error).

Source: `frontends/ui/src/lib/authz/projects.ts:24`

## Anonymous mode

When `REQUIRE_AUTH=false`, the `resolveSession()` helper returns `null` and all project access checks are skipped. The `validateCollectionName()` function in the v1 proxy route blocks uploads to `proj_*` collections with a `403` when there is no session, but read operations may pass through depending on backend configuration.

Source: `frontends/ui/src/app/api/v1/[...path]/route.ts:84`

## Member management

- **List**: Fetches all org users, then queries FGA for memberships matching each project permission slug. Returns a merged list with user details (name, email, role).
- **Add**: Calls `workos.authorization.assignRole()` with `organizationMembershipId`, `resourceExternalId`, and `roleSlug`.
- **Remove**: Finds the role assignment by querying `listRoleAssignmentsForResource()`, then calls `workos.authorization.removeRoleAssignment()`.

Source: `frontends/ui/src/app/api/projects/[id]/members/route.ts`, `frontends/ui/src/app/api/projects/[id]/members/[assignmentId]/route.ts`
