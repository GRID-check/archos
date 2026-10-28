import { beforeEach, describe, expect, it, vi } from 'vitest'

// What Next does when `cookies()` or `headers()` is called with no request in
// scope, which is every job slice the runner runs in its own process.
const OUTSIDE_A_REQUEST = '`cookies` was called outside a request scope.'
const cookies = vi.fn()
const headers = vi.fn()
vi.mock('next/headers', () => ({
  cookies: () => cookies(),
  headers: () => headers(),
}))

const findSavedLocale = vi.fn()
vi.mock('@/lib/user-preferences/locale', () => ({ findSavedLocale: () => findSavedLocale() }))

import { runAsJobSlice } from '@/lib/jobs-queue/slice-scope'
import { LEGACY_LOCALE_COOKIE, defaultLocale } from './config'
import { getLocale, getTranslations } from './server'

beforeEach(() => {
  cookies.mockReset()
  headers.mockReset()
  findSavedLocale.mockReset()
})

describe('getLocale', () => {
  it('reads the person behind a request', async () => {
    cookies.mockResolvedValue({ get: () => ({ value: 'de' }) })
    headers.mockResolvedValue(new Headers())
    findSavedLocale.mockResolvedValue({ known: false, locale: null })

    expect(await getLocale()).toBe('de')
  })

  it('reads the cookie under its old name while the new one is missing (ADR-0145 rule 5)', async () => {
    const jar: Record<string, string> = { [LEGACY_LOCALE_COOKIE]: 'de' }
    cookies.mockResolvedValue({ get: (name: string) => (name in jar ? { value: jar[name] } : undefined) })
    headers.mockResolvedValue(new Headers({ 'accept-language': 'en' }))
    findSavedLocale.mockResolvedValue({ known: false, locale: null })

    expect(await getLocale()).toBe('de')
  })

  it('answers the default in a job slice, which has no request to read', async () => {
    cookies.mockRejectedValue(new Error(OUTSIDE_A_REQUEST))
    headers.mockRejectedValue(new Error(OUTSIDE_A_REQUEST))

    expect(await runAsJobSlice(() => getLocale())).toBe(defaultLocale)
    expect(await runAsJobSlice(async () => (await getTranslations('answerExport'))('documentTitle'))).toEqual(
      expect.any(String)
    )
    expect(cookies).not.toHaveBeenCalled()
    expect(findSavedLocale).not.toHaveBeenCalled()
  })
})
