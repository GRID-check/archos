// @vitest-environment node
import { describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { posthogSupportConfigFromEnv } from './config'

const full = {
  NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com/',
  POSTHOG_PERSONAL_API_KEY: 'phx_test', // pragma: allowlist secret
  POSTHOG_PROJECT_ID: '269895',
}

describe('posthogSupportConfigFromEnv', () => {
  test('derives the app host from the ingestion host and trims the trailing slash', () => {
    expect(posthogSupportConfigFromEnv(full)).toEqual({
      appHost: 'https://eu.posthog.com',
      ingestHost: 'https://eu.i.posthog.com',
      projectId: '269895',
      personalApiKey: 'phx_test', // pragma: allowlist secret
    })
  })

  test('a self-hosted PostHog is its own app host', () => {
    const config = posthogSupportConfigFromEnv({
      ...full,
      NEXT_PUBLIC_POSTHOG_HOST: 'https://ph.example.test',
    })
    expect(config?.appHost).toBe('https://ph.example.test')
    expect(config?.ingestHost).toBe('https://ph.example.test')
  })

  test.each([
    ['no host', { ...full, NEXT_PUBLIC_POSTHOG_HOST: undefined }],
    ['an empty host', { ...full, NEXT_PUBLIC_POSTHOG_HOST: '' }],
    ['no key', { ...full, POSTHOG_PERSONAL_API_KEY: undefined }],
    ['a blank key', { ...full, POSTHOG_PERSONAL_API_KEY: '  ' }],
    ['no project id', { ...full, POSTHOG_PROJECT_ID: undefined }],
    ['a project id that is not digits', { ...full, POSTHOG_PROJECT_ID: '26989x' }],
    ['a project id that is a slug', { ...full, POSTHOG_PROJECT_ID: 'piloti' }],
  ])('is null with %s', (_label, env) => {
    expect(posthogSupportConfigFromEnv(env)).toBeNull()
  })
})
