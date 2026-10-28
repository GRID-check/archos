# Office shelf rename: operator runbook

The office shelf (German: Büroablage) was called `archiv` in code. Everything that
is only code now says `office_shelf` / `officeShelf`. Four things are stored
outside the code and move in steps an operator controls. This page is the
sequence. Nothing here is applied by the deploy except the migrations and the
authz-catalog Job.

| Stored name | Old | New | Who moves it | Read compat |
|---|---|---|---|---|
| `documents.scope` and four sibling tables | `archiv` | `office_shelf` | migration 0170 (deploy) | `LEGACY_DOCUMENT_SCOPES` |
| Two append-only logs (`document_access_log`, `document_quarantine_decisions`) | `archiv` | both accepted | migration 0171 widens the CHECK; old rows stay | `modernizeDocumentScope` |
| Permission slug | `org:archiv:manage` | `org:office_shelf:manage` | steps 1 to 3 below | every check accepts either (`acceptedPermissionSlugs`) |
| Collection name prefix (Qdrant `scope` payload, `documents.collection_name`) | `archiv_<org>` | `office_shelf_<org>` | steps 4 to 6 below | `OFFICE_SHELF_COLLECTION_PREFIXES` |
| Object keys | `org/<org>/archiv/doc/...` | `org/<org>/office_shelf/doc/...` | nothing to do | see below |

## Object store keys: nothing to migrate

`documents.storage_key` holds the key of every object, written at upload and never
re-derived ("a later rename or move never rewrites a stored key, which is read off
the row"). New uploads get `org/<org>/office_shelf/...`; existing objects keep
their `archiv` keys and stay reachable. Do not copy or rename objects. The org
purger deletes `org/<org>/` as a whole, so both spellings go together.

## Permission `org:archiv:manage` to `org:office_shelf:manage`

Safe order, one step per release train. The code accepts either slug the whole
time, so no step can lock anybody out.

1. **Deploy.** The authz-catalog Job (`grid-app-authz-catalog`, compose service
   `workos-authz`) creates `org:office_shelf:manage` and gives the Admin role
   both slugs. The Knowledge Manager role holds both. The old slug stays in the
   catalog, marked `deprecated`.
2. **Re-grant custom roles that hold the old slug.** Custom roles an office built
   itself are not in the catalog, so the Job does not touch them. From
   `apps/workspace`:

   ```bash
   WORKOS_API_KEY=sk_... bun run regrant:office-shelf             # lists the roles, writes nothing
   WORKOS_API_KEY=sk_... bun run regrant:office-shelf -- --apply  # adds the new slug to each; keeps the old one
   ```

   The script covers environment roles and every organization's own roles. It
   stops if the new slug does not exist yet (step 1 not done). It is idempotent.
3. **Later release: remove the old slug.** After a full release with nobody
   holding the old slug only (re-run the dry run: it must list nothing), delete
   `org:archiv:manage` from `catalog.ts`, the `RENAMED_PERMISSIONS` entry in
   `permissions.ts`, the Knowledge Manager role's second slug and the
   `permission-labels.ts` row. Remove the permission in the WorkOS dashboard by
   hand: the provisioner never deletes.

Audit: new rows use the actions `office_shelf.document.uploaded|deleted|renamed`.
The WorkOS audit schemas for them are created by the deploy
(`provision-workos-audit-schemas.mjs`); history keeps `archiv.document.*`, and
the catalogue keeps both.

## Collection prefix `archiv_` to `office_shelf_`

Why it is not an alias. Since ADR-0116 the logical collection is a `scope`
payload field on points in one physical collection (`piloti_office`), so there
is no Qdrant collection called `archiv_<org>` to alias. Renaming means re-tagging
the points and the document rows together.

Until it is done, writers keep the prefix the data has
(`OFFICE_SHELF_COLLECTION_PREFIX = 'archiv_'`, TS and Python, held equal by
`collection-prefix.spec.ts`). Readers and authorizers (`collection-authz.ts`,
`TENANT_PREFIXES`, `jobs/access.py`, `physical_for_scope`) accept both prefixes,
so a re-tagged organization already works.

Per organization, with the app in maintenance for that organization (no upload,
no delete):

4. **Re-tag Qdrant.** Set `scope` on every point of the shelf and `office_id` is
   unchanged:

   ```bash
   curl -X POST "$QDRANT_URL/collections/piloti_office/points/payload?wait=true" \
     -H 'content-type: application/json' -d '{
       "payload": {"scope": "office_shelf_<org>"},
       "filter": {"must": [{"key": "scope", "match": {"value": "archiv_<org>"}}]}}'
   ```

   Check the count with the same filter on `points/count` before (old scope) and
   after (new scope).
5. **Re-tag Postgres** with the schema owner's connection, in one transaction:

   ```sql
   UPDATE documents SET collection_name = 'office_shelf_<org>' WHERE organization_id = '<org>' AND collection_name = 'archiv_<org>';
   ```

   Then look for other holders of the name: `SELECT table_name, column_name FROM information_schema.columns WHERE column_name LIKE '%collection%'` and update each that carries the old value for this organization (jobs' scope lists are history and are left).
6. **Flip the writer**, once every organization is done: set
   `OFFICE_SHELF_COLLECTION_PREFIX` to `'office_shelf_'` in
   `lib/office-shelf/collection-prefix.ts` and `agent/common/source_kinds.py`
   (the parity spec fails if only one changes), and in a following release delete
   the `archiv_` entries from `OFFICE_SHELF_COLLECTION_PREFIXES`.

A snapshot of the `piloti_office` collection first (`docs/deployment/qdrant-runbook.md`)
is the rollback for step 4.

## Routes

`/app/archiv` (query string kept, so `?doc=` links stored in mail or chat still
open) is a permanent redirect to `/app/office-shelf`. `/api/archiv/*` is
rewritten to `/api/office-shelf/*` so an open tab or an agent pod mid-rollout
keeps working. Both rules live in `next.config.ts`; delete them one release
after the rollout. No stored URL needs a data migration: inbox targets and share
links are computed when they are read, not stored.
