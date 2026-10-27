/**
 * @vitest-environment node
 *
 * The boot line, and the pin that keeps its two implementations identical.
 *
 * `src/lib/boot.ts` is canonical; `server.js` carries a hand-written CommonJS
 * copy because it cannot import a TS module (its header says why, and the
 * signed-envelope builder above it is duplicated for the same reason). A copy
 * that nothing compares is a copy that drifts, and the drift here is silent:
 * two containers of the same deployment would print two different answers to
 * "what is running", which is precisely the question the line exists to settle.
 *
 * So this spec does not read the copy's source and assert on a regex. It
 * EXTRACTS the function body and runs it, against the same table the canonical
 * implementation is run over. `bootLogLine` is written pure and self-contained
 * to make that possible; if someone reaches out of it for a module-scope
 * helper, `new Function` throws and this spec says so.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { bootLine, deployedSha, flagSource, formatBootLine, UNKNOWN_SHA } from '@/lib/boot'

/** Env cases both implementations must agree on, byte for byte. */
const CASES: Array<{ name: string; env: Record<string, string>; expected: string }> = [
  {
    name: 'an unstamped image with nothing configured — the compose defaults',
    env: {},
    expected: '[boot] sha=unknown flags=defaults',
  },
  {
    name: 'a published image that signs people in',
    env: {
      GIT_SHA: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c', // pragma: allowlist secret
      REQUIRE_AUTH: 'true',
    },
    expected: '[boot] sha=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c flags=workos', // pragma: allowlist secret
  },
  {
    name: 'REQUIRE_AUTH=false is the anonymous deployment, not WorkOS',
    env: { GIT_SHA: 'abc1234', REQUIRE_AUTH: 'false' },
    expected: '[boot] sha=abc1234 flags=defaults',
  },
  {
    name: 'only the exact word true signs people in — "1" does not',
    env: { REQUIRE_AUTH: '1' },
    expected: '[boot] sha=unknown flags=defaults',
  },
  {
    name: 'case is ignored and the sha is trimmed, as an env_file produces them',
    env: { GIT_SHA: '  deadbeef  ', REQUIRE_AUTH: 'TRUE' },
    expected: '[boot] sha=deadbeef flags=workos',
  },
  {
    name: 'a padded REQUIRE_AUTH is anonymous, because isAuthRequired reads it so',
    env: { REQUIRE_AUTH: ' true ' },
    expected: '[boot] sha=unknown flags=defaults',
  },
  {
    name: 'an empty GIT_SHA is an unstamped image, not an empty sha',
    env: { GIT_SHA: '' },
    expected: '[boot] sha=unknown flags=defaults',
  },
]

describe('the boot line', () => {
  it.each(CASES)('formats $name', ({ env, expected }) => {
    const typed = env as unknown as NodeJS.ProcessEnv
    expect(formatBootLine({ sha: deployedSha(typed), flags: flagSource(typed) })).toBe(expected)
    expect(bootLine(typed)).toBe(expected)
  })

  it('names an unstamped image `unknown` rather than leaving the field empty', () => {
    // An empty value would read as "sha=" in a log and look like a truncation.
    expect(deployedSha({} as NodeJS.ProcessEnv)).toBe(UNKNOWN_SHA)
    expect(bootLine({} as NodeJS.ProcessEnv)).toContain(`sha=${UNKNOWN_SHA}`)
  })

  it('keeps every field on ONE line — the operator greps for it', () => {
    for (const { env } of CASES) {
      expect(bootLine(env as unknown as NodeJS.ProcessEnv).split('\n')).toHaveLength(1)
    }
    expect(bootLine({} as NodeJS.ProcessEnv).startsWith('[boot] ')).toBe(true)
  })
})

describe("server.js's CommonJS copy of the boot line", () => {
  const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8')

  /** Pull `bootLogLine` out of the gateway's source and make it callable. */
  const extracted = (): ((env: Record<string, string>) => string) => {
    const start = source.indexOf('function bootLogLine(env) {')
    expect(start, 'server.js no longer has the bootLogLine this spec pins').toBeGreaterThan(-1)
    const bodyStart = source.indexOf('{', start)
    // Balanced-brace scan: the function contains braces of its own (the
    // template literal), so indexOf('}') would cut it in the middle.
    let depth = 0
    let end = -1
    for (let i = bodyStart; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    expect(end, 'unbalanced braces while extracting bootLogLine').toBeGreaterThan(-1)
    return new Function(`${source.slice(start, end + 1)}; return bootLogLine`)() as (
      env: Record<string, string>
    ) => string
  }

  it('is called from the listen callback, so a booted gateway always prints it', () => {
    expect(source).toContain('console.log(bootLogLine(process.env))')
  })

  it.each(CASES)('agrees with lib/boot.ts on $name', ({ env, expected }) => {
    expect(extracted()(env)).toBe(expected)
  })
})
