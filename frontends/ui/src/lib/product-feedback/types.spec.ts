/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { submitProductFeedbackSchema } from './types'

const base = { kind: 'idea', message: 'Bitte eine Exportfunktion für Pläne.' }

describe('submitProductFeedbackSchema', () => {
  it('fills the defaults a minimal form sends', () => {
    expect(submitProductFeedbackSchema.parse(base)).toEqual({
      ...base,
      pagePath: null,
      allowContact: true,
      context: {},
      posthog: { widgetSessionId: null, sessionId: null },
    })
  })

  it("keeps the browser's PostHog ids when they are id-shaped, and drops anything else", () => {
    const parsed = submitProductFeedbackSchema.parse({
      ...base,
      posthog: { widgetSessionId: '0199f9a0-0000-7000-8000-00000000c1a0', sessionId: 'javascript:alert(1)' },
    })
    expect(parsed.posthog).toEqual({ widgetSessionId: '0199f9a0-0000-7000-8000-00000000c1a0', sessionId: null })
  })

  it('refuses a message too short to act on', () => {
    expect(submitProductFeedbackSchema.safeParse({ ...base, message: 'Bug' }).success).toBe(false)
  })

  it('refuses a kind the table would refuse', () => {
    expect(submitProductFeedbackSchema.safeParse({ ...base, kind: 'rant' }).success).toBe(false)
  })

  it('keeps an app path and drops anything that is not one, instead of refusing the report', () => {
    const parse = (pagePath: string) => submitProductFeedbackSchema.parse({ ...base, pagePath }).pagePath
    expect(parse('/app/projects/123/chat')).toBe('/app/projects/123/chat')
    expect(parse('https://evil.test/app')).toBeNull()
    expect(parse('/app?token=secret')).toBeNull()
  })

  it('strips context keys it does not know', () => {
    const parsed = submitProductFeedbackSchema.parse({
      ...base,
      context: { viewport: '1440x900', cookie: 'session=abc' },
    })
    expect(parsed.context).toEqual({ viewport: '1440x900' })
  })
})
