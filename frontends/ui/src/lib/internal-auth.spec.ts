// @disk-inputs: server.js, src/**
/**
 * @vitest-environment node
 */

/**
 * The service token's outbound half: one producer, one missing-token policy,
 * and a ratchet that keeps a second producer from coming back.
 *
 * The header used to be written at sixteen call sites with three policies
 * nobody chose: send an empty token, throw a 503, or quietly omit it. The
 * backend refuses every one of those requests that lacks a valid token
 * (`apps/backend/src/aiq_api/routes/internal_auth.py`), so the empty
 * header only bought a misleading 403.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServiceUnavailableError } from '@/lib/api/errors'
import {
  INTERNAL_TOKEN_HEADER,
  InternalServiceUnavailableError,
  internalServiceHeaders,
} from './internal-auth'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('internalServiceHeaders', () => {
  it('carries the token to an internal destination', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'secret')
    expect(internalServiceHeaders('http://aiq-api:8000')).toEqual({ 'x-grid-internal-token': 'secret' })
    expect(internalServiceHeaders('https://backend.example.com')).toEqual({ [INTERNAL_TOKEN_HEADER]: 'secret' })
  })

  it.each([undefined, ''])('refuses with a 503 when the token is %j, so nothing is sent', (token) => {
    vi.stubEnv('INTERNAL_API_TOKEN', token)
    let thrown: unknown
    try {
      internalServiceHeaders('http://aiq-api:8000')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InternalServiceUnavailableError)
    expect(thrown).toBeInstanceOf(ServiceUnavailableError)
    expect(thrown).toMatchObject({ status: 503, reason: 'token_missing' })
  })

  it('refuses to carry the token over plain HTTP to a public host', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'secret')
    expect(() => internalServiceHeaders('http://backend.example.com')).toThrow(
      expect.objectContaining({ status: 503, reason: 'unsafe_destination' })
    )
  })
})

const UI_ROOT = path.resolve(__dirname, '../..')
const PRODUCER = 'src/lib/internal-auth.ts'
const HEADER = 'x-grid-internal-token'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) return []
    return [full]
  })
}

/** Every string literal in `file` that spells the header, in any case. Comments do not count. */
function headerLiterals(file: string): number {
  const text = readFileSync(file, 'utf8')
  if (!text.toLowerCase().includes(HEADER)) return 0
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let hits = 0
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.toLowerCase() === HEADER) {
      hits += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

describe('the header has one producer', () => {
  it('no file but internal-auth.ts spells the service-token header', () => {
    const files = [...sourceFiles(path.join(UI_ROOT, 'src')), path.join(UI_ROOT, 'server.js')]
    const offenders = files
      .map((file) => path.relative(UI_ROOT, file).split(path.sep).join('/'))
      .filter((file) => file !== PRODUCER && headerLiterals(path.join(UI_ROOT, file)) > 0)
    expect(
      offenders,
      'Send the service token with internalServiceHeaders(baseUrl) from @/lib/internal-auth; read it inbound with requireInternalToken or INTERNAL_TOKEN_HEADER.'
    ).toEqual([])
  })

  it('the scan sees the producer it exempts', () => {
    expect(headerLiterals(path.join(UI_ROOT, PRODUCER))).toBe(1)
  })
})
