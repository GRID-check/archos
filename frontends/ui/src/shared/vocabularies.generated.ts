// AUTO-GENERATED from the Python sources named below — do not edit; run `uv run python scripts/generate_vocabularies.py`

/** The kinds a person may delegate: `TaskKind` in `src/aiq_agent/cards/models.py`. */
export const DELEGATABLE_TASK_KINDS = ["compliance_check", "submission_check", "document", "revision"] as const

/** The coarse source kinds: the keys of `SOURCE_KINDS` in `src/aiq_agent/common/source_kinds.py`. */
export const SOURCE_KINDS = ["building_law", "office", "project", "web", "measurement"] as const

/** The shelves a retrieved chunk can come from: `Shelf` in `src/aiq_agent/common/source_kinds.py`. */
export const SHELVES = ["office_shelf", "project", "session", "base"] as const
