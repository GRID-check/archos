/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { replyToProductFeedbackSchema, submitProductFeedbackSchema } from './types'

const base = { kind: 'idea', message: 'Bitte eine Exportfunktion für Pläne.' }

describe('submitProductFeedbackSchema', () => {
  it('fills the defaults a minimal form sends', () => {
    expect(submitProductFeedbackSchema.parse(base)).toEqual({
      ...base,
      pagePath: null,
      allowContact: true,
      context: {},
      posthog: { sessionId: null },
    })
  })

  it("keeps the browser's replay session when it is id-shaped, and drops anything else", () => {
    const parse = (sessionId: string) => submitProductFeedbackSchema.parse({ ...base, posthog: { sessionId } }).posthog
    expect(parse('0199f9a0-0000-7000-8000-00000000c1a0')).toEqual({ sessionId: '0199f9a0-0000-7000-8000-00000000c1a0' })
    expect(parse('javascript:alert(1)')).toEqual({ sessionId: null })
  })

  it('strips the widget session an older client still sends: the server opens its own', () => {
    const parsed = submitProductFeedbackSchema.parse({
      ...base,
      posthog: { widgetSessionId: '0199f9a0-0000-7000-8000-00000000c1a0', sessionId: null },
    })
    expect(parsed.posthog).toEqual({ sessionId: null })
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

describe('replyToProductFeedbackSchema', () => {
  it('trims a reply and refuses an empty or oversized one', () => {
    expect(replyToProductFeedbackSchema.parse({ message: '  Danke!  ' })).toEqual({ message: 'Danke!' })
    expect(replyToProductFeedbackSchema.safeParse({ message: '   ' }).success).toBe(false)
    expect(replyToProductFeedbackSchema.safeParse({ message: 'x'.repeat(5001) }).success).toBe(false)
  })
})
