/**
 * The one way this process opens a Dragonfly connection (ADR-0020, ADR-0110).
 *
 * CommonJS for the same reason as `lib/limits/rules.js`: `server.js` opens one
 * too and cannot import TypeScript. ioredis is required lazily, so bundles that
 * never set `REDIS_URL` never load it.
 *
 * Two rules every caller used to get wrong on its own:
 *
 * - **A cold client queues; a warm one fails fast.** With
 *   `enableOfflineQueue: false` a client refuses every command until its first
 *   connect lands ("Stream isn't writeable"), so the first request a fresh pod
 *   serves read as a cache miss, an unenforced limit, or a subscription that
 *   never happened (docs/contributing/gotchas.md). So every client queues until
 *   its first `ready`, bounded by `commandTimeout`, and only then turns the
 *   queue off, so a later outage fails open at once instead of holding requests.
 *   `queueWhileDown: true` keeps the queue on for good, for clients whose
 *   commands are worth a short wait (pub/sub, the roster, the replay peek).
 * - **Log the outage, not the attempts.** ioredis emits `error` on every
 *   reconnect attempt, and each of a process's clients did. A ninety-second
 *   Dragonfly restart was three thousand warn lines. Now it is one warn per
 *   client when the connection drops and one info line when it is back.
 *
 * @param {string} url `REDIS_URL`
 * @param {string} label the log prefix, e.g. `cache`
 * @param {{ commandTimeout?: number, queueWhileDown?: boolean }} [options]
 * @returns {any} the ioredis client
 */
function createRedisClient(url, label, options = {}) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const IORedis = require('ioredis')
  const client = new IORedis(url, {
    connectTimeout: 1000,
    commandTimeout: options.commandTimeout ?? 1000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    lazyConnect: false,
  })
  /** When the current outage began; null while connected or before the first connect fails. */
  let downSince = null
  let attempts = 0
  client.on('ready', () => {
    // ioredis reads this option on every command, so turning it off here takes effect at once.
    if (!options.queueWhileDown) client.options.enableOfflineQueue = false
    if (downSince !== null) {
      const seconds = Math.round((Date.now() - downSince) / 1000)
      console.info(`[${label}] redis reconnected after ${seconds}s (${attempts} failed attempts)`)
    }
    downSince = null
    attempts = 0
  })
  client.on('error', (error) => {
    attempts += 1
    if (downSince !== null) return
    downSince = Date.now()
    console.warn(`[${label}] redis unreachable, degrading until it is back:`, error?.message ?? error)
  })
  return client
}

module.exports = { createRedisClient }
