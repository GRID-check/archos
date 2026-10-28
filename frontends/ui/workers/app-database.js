// @ts-check
/**
 * The purger's and the scheduler's postgres-js client: one per process,
 * connecting as `app_rw` like the BFF. Their work spans tenants, so every
 * transaction steps up to the platform role explicitly (`./platform-scope.js`)
 * rather than this connection being privileged (ADR-0041).
 *
 * CommonJS for the same reason as `./job-queue.js`: both run as plain `node`
 * processes off the frontend image, with no build step.
 */

const postgres = require('postgres')

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('postgres').Sql}
 */
function createSql(env = process.env) {
  const url = env.GRID_APP_DATABASE_URL
  if (!url) throw new Error('GRID_APP_DATABASE_URL is not defined')
  return postgres(url, { prepare: false })
}

module.exports = { createSql }
