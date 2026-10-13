/**
 * „Was Piloti tut" — the rules and the reads behind `GET /api/projects/[id]/piloti-activity`
 * (`docs/architecture/piloti-activity.md`; the contract is `./types`).
 *
 * A read over records that already exist; nothing here writes, and there is no
 * table of its own. Each section is built from bounded queries, every one
 * scoped to the organization and the project, and gated for THIS reader so the
 * view never shows a row the reader could not open from where it lives.
 *
 * STUB: the contract is landed, the reads are not. The server builder replaces
 * the body of {@link getPilotiActivity} and keeps its signature. What follows
 * is the specification it implements.
 *
 * ## Entry
 *
 * 1. `requireProjectAccess(session, projectId, 'project:view')`; its denial is
 *    the 404 every project route answers. Keep the returned `ProjectAccess`
 *    (`closed`, `readsBecauseClosed`).
 * 2. `projectOverviewReader(session, projectId)` (`lib/projects/service.ts`)
 *    gives `{ hiddenFolderIds, reader }`. EVERY query that reads a document or
 *    a document's facts (marks, wakes, changes, a filed document) joins
 *    `documents` and ANDs, in that query's WHERE:
 *    `documents.organization_id = org`, `documents.project_id = projectId`,
 *    `documentVisibleTo(reader)` (`lib/documents/visibility.ts`) and
 *    `...outsideHiddenFolders(hiddenFolderIds)` (`lib/documents/repository.ts`).
 *    So a held upload, a document in a folder closed to the reader, a
 *    Büroablage document and another project's document never reach a row.
 * 3. Conversations, two ways, both the conversation list's own rule
 *    (`listConversations` in `lib/conversations/service.ts`), so this view and
 *    the chat never disagree about which thread the reader may open:
 *    - **In SQL, before the LIMIT**, for the rows that live in a conversation
 *      (proposals, changes): join `conversations` on id and organization, AND
 *      `conversations.deleted_at IS NULL`, `conversations.project_id = projectId`
 *      and the visibility predicate. Extract that predicate from
 *      `listVisibleConversations` (`lib/conversations/repository.ts`, the
 *      project branch: `visibility <> 'private' OR created_by = me OR a grant
 *      names me`) into an exported
 *      `conversationVisibleInProject(organizationId, userId, projectId): SQL`
 *      and make `listVisibleConversations` use it, so the two cannot drift.
 *    - **After the query**, drop the rows whose conversation is in
 *      `lockedConversationIds(session, refs)` (`lib/conversations/restricted-use.ts`):
 *      a thread that drew on a restricted folder, or another project, the
 *      reader may not read now (ADR-0087, ADR-0088, ADR-0094). One call for
 *      the whole response.
 *    - For a LINK only (a wake's turn, a run's block), the same two halves
 *      over the bounded set of ids: a repository function
 *      `listVisibleConversationIds(organizationId, userId, projectId, ids)`
 *      (the predicate above, `id IN ids`, `LIMIT ids.length`) minus
 *      `lockedConversationIds`. A row is still shown when its thread is not
 *      readable; it just carries no `turn` / `run` target.
 *    `conversationOpenToProjectReaders` is NOT the gate here: it is the rule
 *    for text read into EVERY member's prompt, and it would hide a person's own
 *    restricted thread from that person.
 * 4. Names: `loadOrganizationDirectory(organizationId)` once
 *    (`lib/sharing/directory.ts`); `forPerson = { userId, name: directory.get(userId)?.name ?? null }`.
 * 5. `capabilities = { wakes: isPilotiWakesEnabled(session), automation: isSkillsEnabled(session) }`
 *    (`lib/authz/feature-flags.ts`). Neither hides rows: a wake recorded
 *    before the switch went off is still true.
 *
 * Coerce every raw value at the repository boundary (`new Date(row.x)`,
 * `Number(row.count)`), and write instants with `toISOString()`.
 *
 * ## running (Läuft gerade)
 *
 * **Wakes** — a new `listLiveProjectWakes(organizationId, projectId, docGate, limit)`
 * in `lib/annotations/wake-repository.ts`: `piloti_wakes` JOIN
 * `document_annotations` (id, organization) JOIN `documents` (step 2), WHERE
 * `piloti_wakes.organization_id = org` AND `status IN ('queued','started')`,
 * ORDER BY `piloti_wakes.created_at DESC, piloti_wakes.id DESC`,
 * LIMIT `PILOTI_ACTIVITY_RUNNING_CAP` + 1 (the extra row only says
 * `truncated`). Select the wake, the mark's `number`, `kind`, `body`,
 * `delegated_at`, and the document's display fields. Per row:
 * - `startedAt` = `settled_at` when `status = 'started'`, else null.
 * - `mark.excerpt` = the body cut to `MARK_EXCERPT_MAX` (at a word, „…").
 * - `canTakeBack` = `trigger_kind = 'assigned'` AND the mark's `delegated_at`
 *   is set AND `event_id = delegationEventId(markId, delegatedAt)`
 *   (`lib/annotations/wake-ids.ts`: still THIS delegation) AND the reader may
 *   edit the document's marks. Export the annotations service's own
 *   `mayWrite(session, documentId)` (`lib/annotations/service.ts`) as
 *   `mayEditAnnotations` and ask it once per distinct document of those rows.
 * - `target = { kind: 'review', documentId, annotationId: markId }`.
 * - `turn`: the wake ran in its person's thread about the document,
 *   `documentThreadConversationId(documentId, actorUserId)`, at the message
 *   the job wrote, whose id is the wake's id. `{ kind: 'turn', conversationId,
 *   messageId: wake.id }` when that id passes the link gate (step 3), else
 *   null. In practice only the person who acted, or someone they shared the
 *   thread with, gets a link.
 *
 * **Runs** — a new `listActiveRunsInProject(projectId, organizationId, limit)`
 * in `lib/tasks/repository.ts`: `task_runs` WHERE organization, project and
 * `status IN ('queued','running')`, ORDER BY `created_at DESC, id DESC`,
 * LIMIT cap + 1. Then `withoutUnreadableSubjects(session, projectId, rows)`
 * (`lib/tasks/subject-access.ts`), the Aufträge list's own rule. Per row:
 * - `canStop` = what `requireRunActor` (`lib/runs/service.ts`) would let
 *   through, decided once for the response: `requireProjectAccess(session,
 *   projectId, CHAT_PERMISSIONS)` holds (caught: false), and not
 *   (`readsBecauseClosed` AND `requesterUserId !== session.userId`); and per
 *   row `backendJobId !== null`.
 * - `target`: `{ kind: 'run', conversationId, messageId: runMessageId, runId }`
 *   when both ids are set and the conversation passes the link gate; else
 *   `{ kind: 'task', taskId: run.id }` when `capabilities.automation`; else null.
 *
 * Merge both lists by `at` DESC (ties: `id` DESC), keep the first cap rows,
 * `truncated` = either source had more than cap rows or the merge cut any.
 *
 * ## waiting (Wartet auf Entscheidung)
 *
 * **Proposals** — a new `listOpenProposalsInProject(organizationId, projectId, userId, limit)`
 * in `lib/proposals/repository.ts`: `proposed_changes` LEFT JOIN
 * `conversations` (origin id and organization) WHERE organization, project,
 * `status = 'proposed'`, AND (`origin_conversation_id IS NULL` OR (the
 * conversation exists, `deleted_at IS NULL`, `project_id = projectId`, and
 * `conversationVisibleInProject(...)`)), ORDER BY `created_at DESC, id DESC`,
 * LIMIT `PILOTI_ACTIVITY_WAITING_CAP` + 1. Then drop the locked ones
 * (step 3). This is `requireReadableProposal`'s rule as a list: a proposal
 * with no conversation needs only `project:view`. Per row:
 * - `summary = summaryOf(parseKindPayload(kind, payload))` (`lib/proposals/kinds.ts`);
 *   a payload that does not parse is skipped and logged, never a 500.
 * - `canDecide`: `requireProjectAccess(session, projectId, DECIDE_PERMISSIONS[kind])`
 *   holds, asked once per kind present (at most three calls).
 * - `target`: `{ kind: 'turn', conversationId: origin, messageId: originMessageId }`
 *   when there is an origin conversation, else `{ kind: 'project_chat' }`.
 *
 * **Proposed marks** — two new functions in `lib/annotations/repository.ts`:
 * - `listProposedMarkDocuments(organizationId, projectId, docGate, limit)`:
 *   `document_annotations` JOIN `documents` (step 2) WHERE organization,
 *   `status = 'proposed'`, GROUP BY the document, selecting `count(*)` and
 *   `max(created_at)`, ORDER BY that max DESC, document id DESC, LIMIT
 *   `PROPOSED_MARK_DOCUMENTS_CAP` + 1.
 * - `listProposedMarkSamples(organizationId, documentIds, perDocument)`:
 *   the first `PROPOSED_MARK_SAMPLE` proposed marks of each named
 *   document by `number` (a `row_number() OVER (PARTITION BY document_id
 *   ORDER BY number)` filter), LIMIT `documentIds.length * perDocument`. It
 *   also joins `documents` with step 2's predicates (the visibility spec
 *   counts `document_annotations` as a document fact).
 * Per row: `id = document.id`, `count`, `marks` (number, kind, excerpt, page,
 * `forPerson` from `created_by`, `createdAt`), `target = { kind: 'review',
 * documentId, annotationId: marks[0].id }`.
 *
 * Merge by `at` DESC, keep the first `PILOTI_ACTIVITY_WAITING_CAP`,
 * `truncated` as for `running`.
 *
 * ## recent (Zuletzt)
 *
 * `since = recentSince(query, now)` (`./types`), `limit = query.limit`. Each
 * source reads at most `limit + 1` rows with its own time column `>= since`:
 *
 * **Ended wakes** — `listEndedProjectWakes(organizationId, projectId, docGate, since, limit)`
 * in `lib/annotations/wake-repository.ts`: as the live read, with
 * `status IN ('answered','stopped','failed','refused')` (`ENDED_WAKE_STATUSES`;
 * `suppressed` is left out) and `ended_at >= since`, ORDER BY `ended_at DESC,
 * id DESC`. `at = ended_at`; `reason` only for `failed` and `refused`; `target`
 * and `turn` as for a live wake.
 *
 * **Finished runs** — `listFinishedRunsInProject(projectId, organizationId, since, limit)`
 * in `lib/tasks/repository.ts`: `status IN ('succeeded','failed','interrupted',
 * 'skipped','error')` and `COALESCE(finished_at, updated_at) >= since`, ORDER
 * BY that DESC, id DESC; then `withoutUnreadableSubjects`. `at` = that
 * instant; `error` as stored; `filedDocument` = the filed document's id and
 * display name when ONE batched read of the rows' `filed_document_id`s under
 * step 2's predicates returns it, else null; `target` as for a running run.
 *
 * **Changes** — `listRecentTurnChanges(organizationId, projectId, userId, docGate, since, limit)`
 * in `lib/changes/repository.ts`: `piloti_changes` JOIN `documents` (step 2)
 * JOIN `conversations` (origin id and organization; the SQL half of step 3)
 * WHERE organization and `created_at >= since`, GROUP BY
 * (`origin_conversation_id`, `origin_message_id`), selecting `count(*)`,
 * `count(undone_at)`, `max(created_at)`, `min(on_behalf_of)` (one per turn),
 * `count(DISTINCT document_id)` and the first `CHANGE_DOCUMENTS_SHOWN`
 * distinct document ids (`(array_agg(DISTINCT document_id))[1:3]`), ORDER BY
 * `max(created_at) DESC`, LIMIT `limit + 1`. Then drop locked conversations
 * and name the documents (one read, step 2). This is the turn card's own rule
 * (`listTurnChanges`: `viewer` on the conversation, changes on documents the
 * reader may not see left out) as a list. `id = conversationId + ':' +
 * messageId`; `target = { kind: 'turn', conversationId, messageId }`.
 *
 * Merge the three by `at` DESC (ties: `id` DESC), keep the first `limit`,
 * `truncated` as above, `since` written back as `since.toISOString()`.
 *
 * ## Bounds, indexes and the guards that check them
 *
 * Every list above is LIMITed; nothing is read whole. Migration 0144
 * (`piloti_activity_indexes`, with its `.down.sql`) adds what these reads
 * scan by: `piloti_wakes (organization_id, created_at DESC) WHERE status IN
 * ('queued','started')`, `piloti_wakes (organization_id, ended_at DESC) WHERE
 * ended_at IS NOT NULL`, and `piloti_changes (organization_id, created_at
 * DESC)`. Add `pilotiWakes: 'piloti_wakes'` to `GUARDED_TABLES` in
 * `lib/documents/document-visibility.spec.ts` (a wake is a document fact; the
 * new reads compose `documentVisibleTo`, the existing ones get allowlist
 * entries saying they are keyed by a mark or a wake id already authorized).
 *
 * Nothing calls a model, so nothing is traced to Langfuse.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { PilotiActivityQuery, PilotiActivityResponse } from './types'

/**
 * What Piloti is doing in `projectId`, as `session`'s person may see it: the
 * three sections of {@link PilotiActivityResponse}. 404 (`NotFoundError`) for
 * a project the person may not view. Specified in the module header.
 */
export async function getPilotiActivity(
  session: AuthorizedSession,
  projectId: string,
  query: PilotiActivityQuery
): Promise<PilotiActivityResponse> {
  void session
  void projectId
  void query
  throw new Error('not implemented')
}
