'use strict'

/**
 * Read the old names of the environment variables for one release.
 *
 * The variables lost the product's name: `GRID_X`, and before it `AIQ_X`, is
 * now `X`. Every Node process of the UI image loads this first (the image sets
 * `NODE_OPTIONS=--require /app/scripts/legacy-env-names.cjs`), so a deployment
 * still on the old names keeps working and no reader in the code knows them.
 * A name already set wins over `GRID_X`, which wins over `AIQ_X`.
 *
 * The same table as `LEGACY_PREFIXES` and `RENAMED` in `apps/agent-host/entrypoint.py`,
 * which does this for the backend image; `tests/test_entrypoint_roles.py`
 * holds the two equal. Then this file goes.
 */

const LEGACY_PREFIXES = ['GRID_', 'AIQ_']

/** Where the bare name would collide with one a library or the platform reads, or still carry the product's name. */
const RENAMED = {
  ROLE: 'PROCESS_ROLE',
  VERBOSE: 'AGENT_VERBOSE',
  LANGFUSE_TRACE_RETENTION_DAYS: 'TRACE_RETENTION_DAYS',
  PILOTI_ASK_MAX_SECONDS: 'AGENT_ASK_MAX_SECONDS',
}

/** Every reader reads the new names, so an old one is worth a warning (as `WARN` in `apps/agent-host/entrypoint.py`). */
const WARN = true

/** The name `legacy` is read as now, or null when it carries no old prefix. */
function currentName(legacy) {
  for (const prefix of LEGACY_PREFIXES) {
    if (legacy.startsWith(prefix) && legacy.length > prefix.length) {
      const rest = legacy.slice(prefix.length)
      return Object.hasOwn(RENAMED, rest) ? RENAMED[rest] : rest
    }
  }
  return null
}

/** Copy each old name onto its current one where that is unset, warning once per name. Returns the names it set. */
function adoptLegacyNames(
  env = process.env,
  warn = (line) => WARN && process.stderr.write(`${line}\n`)
) {
  const adopted = []
  for (const prefix of LEGACY_PREFIXES) {
    for (const legacy of Object.keys(env)
      .filter((name) => name.startsWith(prefix))
      .sort()) {
      const name = currentName(legacy)
      if (name === null) continue
      if (env[name] !== undefined) {
        warn(`WARNING: ${legacy} is deprecated and ignored, ${name} is set`)
        continue
      }
      env[name] = env[legacy]
      adopted.push(name)
      warn(`WARNING: ${legacy} is deprecated; rename it to ${name}`)
    }
  }
  return adopted
}

adoptLegacyNames()

module.exports = { LEGACY_PREFIXES, RENAMED, adoptLegacyNames, currentName }
