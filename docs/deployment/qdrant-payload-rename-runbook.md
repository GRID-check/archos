# Qdrant payload rename runbook

The English names of the payload keys the knowledge layer filters on, and how
to rewrite the points that still carry the German ones so the read fallback
can be deleted. Operating the cluster itself is
[`qdrant-runbook.md`](qdrant-runbook.md). The rename moved `FACT_KEYS`, the
boost weights, the clause keys and the `read_passage` argument together.

**Status: undrilled.** The script ran against an in-memory client in the
test suite and was never pointed at a server. Take the snapshot, run the dry
run, and read its counts before `--apply`.

## What changed

| Was (points written before) | Is (every new point) | Index type |
|---|---|---|
| `project_facts.bundesland` | `project_facts.federal_state` | keyword |
| `project_facts.gebaeudeklasse` | `project_facts.building_class` | integer |
| `project_facts.bauweise` | `project_facts.construction_method` | keyword |
| `project_facts.nutzungen` | `project_facts.uses` | keyword |
| `project_facts.vorhabensart` | `project_facts.work_type` | keyword |
| `punkt_id`, `punkt_path`, `punkt_title`, `punkt_parent_id` | `clause_id`, `clause_path`, `clause_title`, `clause_parent_id` | keyword |
| `punkt_depth` | `clause_depth` | integer |
| `richtlinie` | `guideline` | keyword |
| `chunking: "punkt"` | `chunking: "clause"` | keyword (same key) |

The fact **tokens** moved with the keys: `wien` is now `vienna`, `holzbau`
`timber`, `wohnen` `residential`, `neubau` `new_build` (the table is
`LEGACY_PROFILE_TOKENS` in `packages/agent/src/agent/profile_names.py`).

The wire between the BFF and `agent_host` changed with it: the boost weights are
`building_class_adjacent`, `use`, `use_max` (were `gebaeudeklasse_adjacent`,
`nutzung`, `nutzung_max`), and `agent_host` stopped translating to German on the
way to the store. `agent_host` still accepts the German names on the request, so
a BFF pod that has not rolled yet keeps working.

## What reads both until the rewrite has run

- **Filters** (`knowledge_layer/qdrant/scope.py`): a condition on a new name
  matches the new name **or** the old one (`should`), with the German token for
  the old key; a negative condition (`$ne`, `$nin`) excludes both. That covers
  `read_passage`'s clause and outline filters, the `chunking != page` exclusion,
  the cross-project fact filters and anything a model sends as a raw filter.
- **Boost** (`qdrant/boost.py`): every fact term is "new key OR old key".
- **Hits** (`qdrant/payload.py`, `chunk_metadata`): a point's metadata is read
  back under the new names, the new key winning when both exist.
- **Indexes**: the old keys stay in `INDEXED_FIELDS`, so a fresh collection has
  them too and strict mode never refuses a filter on either spelling.

Writers write only the new names. A project's facts are one object written at
once (`project_payload`), so the next fact change or upload on a project
rewrites its points' `project_facts` in the new spelling anyway; the clause
keys only change on a re-ingest of the file. Most of the corpus is never
re-ingested, which is why the rewrite is a script.

## Procedure

Run it from a pod that has `QDRANT_URL` and `QDRANT_API_KEY` and the
repository's `scripts/` (every `aiq-api` pod).

1. **Deploy the release and let the rollout finish.** The first backend start
   creates the new payload indexes on both collections (`ensure_payload_indexes`
   runs before the first query; it is idempotent). Pods of the old release that
   are still draining write German keys, which is why the rewrite waits for the
   rollout to complete. Check the indexes exist:

   ```bash
   q $P0/collections/piloti_office | jq '.result.payload_schema | keys[] | select(test("federal_state|building_class|construction_method|^uses|work_type|clause_|guideline"))'
   ```

   To create them by hand (or on a collection the backend has not touched),
   `scripts/qdrant_rename_payload_keys.py ... --apply` does it as its first
   step; the REST equivalent per field is
   `q -X PUT -d '{"field_name":"project_facts.federal_state","field_schema":"keyword"}' "$P0/collections/piloti_office_v1/index?wait=true"`
   (`integer` for `project_facts.building_class` and `clause_depth`).

2. **Snapshot.** A rewrite cannot be undone by the script: the previous release
   no longer finds a clause by `punkt_id` once the key is gone.

   ```bash
   kubectl -n grid create job --from=cronjob/qdrant-snapshot qdrant-snapshot-pre-payload-rename-$(date +%s)
   ```

3. **Record the point counts**, which the rewrite must not change:

   ```bash
   q -X POST -d '{"exact":true}' $P0/collections/piloti_office/points/count
   q -X POST -d '{"exact":true}' $P0/collections/piloti_corpus/points/count
   ```

4. **Dry run.** Writes nothing, not even the indexes. It reads every point and
   tells you how many would change and which fields:

   ```bash
   kubectl -n grid exec deploy/aiq-api -- python scripts/qdrant_rename_payload_keys.py all
   ```

   Expect `project_facts`, `clause_id`, `guideline` and `chunking` counts on the
   order of the corpus's clause chunks and the office's project points, and
   `punkt_id` etc. as the keys to delete. A count of 0 on a collection that
   should hold German points means you are looking at the wrong alias.

5. **Apply**, in a pod that survives your terminal, while no one is editing a
   project's facts or uploading (the script reads a page, then writes it; a
   fact change that lands in between is overwritten with the stale facts until
   the next change to that project; rerun the step to catch it):

   ```bash
   kubectl -n grid exec deploy/aiq-api -- python scripts/qdrant_rename_payload_keys.py all --apply
   ```

   Per point it first SETS the English fields, then DELETES the German keys, in
   batches of 256 points, so a run that dies half-way leaves points readable
   under both names; run it again and it finishes. A second full run changes
   nothing.

6. **Verify.** The script exits 0 only when no point holds a German key or the
   German `chunking` value:

   ```bash
   kubectl -n grid exec deploy/aiq-api -- python scripts/qdrant_rename_payload_keys.py all --verify
   ```

   Then compare the point counts with step 3 (equal), open one point
   (`q -X POST -d '{"limit":1,"with_payload":true,"filter":{"must":[{"key":"chunking","match":{"value":"clause"}}]}}' $P0/collections/piloti_corpus/points/scroll`)
   and see `clause_id` and `guideline`, no `punkt_id`. Last, an end-to-end read:
   ask the agent to open a clause (`read_passage` with `clause=`), and run a
   cross-project search from a project with a federal state, which exercises the
   boost over the new keys.

7. **Delete the fallback in a later release**, once `--verify` has exited 0 on
   every environment and one release has shipped since: remove
   `LEGACY_FIELDS`, `LEGACY_CHUNKING` and `LEGACY_KEYWORD_FIELDS` in
   `qdrant/schema.py` (and the `punkt_depth`/`gebaeudeklasse` entries in
   `INTEGER_FIELDS`); `_legacy_value`, `_legacy_condition` and the `_field`
   wrapper in `qdrant/scope.py`; `_english_clause_keys` in `qdrant/payload.py`;
   the second branch of `_any` in `qdrant/boost.py`; `legacy_profile_token` in
   `profile_names.py`; `qdrant/legacy_rewrite.py`,
   `scripts/qdrant_rename_payload_keys.py`, their tests
   (`test_qdrant_legacy_payload.py`) and this runbook. The old payload indexes
   can then be dropped:
   `q -X DELETE "$P0/collections/piloti_office_v1/index/punkt_id"`, one per old key.

## Rollback

Before step 5 the previous release still reads everything it wrote, and the new
release's points are readable by it except the new keys it ignores. After step 5
the previous release cannot find a clause by `punkt_id` or a project by
`project_facts.bundesland`: roll the **data** back with the snapshot from step 2,
not the code alone.

## Not covered here

`doc_class` and `chunk_doc_class` still hold the German Dokumentart spelling
(`qdrant_doc_class`, `QDRANT_DOC_CLASSES` in
`packages/agent/src/agent/knowledge/document_classification.py`); that is a separate
rename with its own fallback, and this script does not touch it.
