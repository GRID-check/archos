/**
 * 410 Gone for the old addresses that have no successor (route fates, `../redirects.mjs`).
 *
 * Astro's `redirects` cannot send 410, and Astro renders `src/pages/404.astro` for an
 * unmatched address with status 404 whatever the page sets. So the page itself picks its
 * words (`fateOf` says the address is gone: "Diese Seite gibt es nicht mehr."), and this
 * step, in front of the handler, turns that response's 404 into 410. Every other status
 * passes untouched, so a page that exists can never be answered as gone.
 *
 * In `astro dev` the gone page shows with status 404; the status is production's.
 */
import { fateOf } from '../redirects.mjs'

/** @param {string | undefined} url */
export function isGone(url) {
  const pathname = (url ?? '/').split(/[?#]/, 1)[0]
  let decoded
  try {
    decoded = decodeURI(pathname)
  } catch {
    return false
  }
  return fateOf(decoded)?.status === 410
}

/**
 * Rewrites the 404 the handler is about to write into a 410, for a gone address only.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function goneStatus(req, res) {
  if (!isGone(req.url)) return
  const writeHead = res.writeHead.bind(res)
  // writeHead is overloaded; every overload takes the status first.
  res.writeHead = (status, ...rest) => writeHead(status === 404 ? 410 : status, ...rest)
}
