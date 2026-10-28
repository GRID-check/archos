import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, test } from 'vitest'

import { TimeAgo } from './time-ago'

const ORIGINAL_TZ = process.env.TZ

/** The markup the server sends, rendered in a process whose clock zone is `zone`. */
const renderIn = (zone: string): string => {
  process.env.TZ = zone
  return renderToString(<TimeAgo date="2026-10-27T22:30:00.000Z" locale="de" />)
}

describe('TimeAgo', () => {
  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIGINAL_TZ
  })

  test('first paint does not depend on the zone of the machine that renders it (React #418)', () => {
    // The server runs in UTC, the reader elsewhere: both must produce the same
    // text, or hydration fails with a text mismatch.
    expect(renderIn('UTC')).toBe(renderIn('America/Los_Angeles'))
  })

  test('first paint reads in the office zone', () => {
    expect(renderIn('UTC')).toContain('27.10.2026, 23:30')
  })
})
