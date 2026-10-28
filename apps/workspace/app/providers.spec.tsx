import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppConfig } from '@/shared/context'
import { identifyPosthog, initPosthogClient, registerPosthogContext, resetPosthog } from '@/lib/analytics/posthog'
import { Providers } from './providers'

const layoutState = {
  theme: 'dark',
  setTheme: vi.fn(),
  fetchDataSources: vi.fn(),
  availableDataSources: [] as Array<{ id: string }>,
  setEnabledDataSources: vi.fn(),
}

const chatState = {
  currentConversation: null as { id: string; enabledDataSourceIds?: string[] } | null,
  reconnectToActiveJob: vi.fn(),
  cleanupOrphanedStartingBanners: vi.fn(),
  isDeepResearchStreaming: false,
  loadServerConversations: vi.fn(),
}

vi.mock('@workos-inc/authkit-nextjs/components', () => ({
  AuthKitProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

// PostHogIdentitySync reads useAuth; the AuthKit mock above provides no
// session, so stub the adapter. Mutable, because the identity tests below
// need to move the session between users and to signed-out mid-test.
const authState = {
  isAuthenticated: false,
  isLoading: false,
  authRequired: false,
  user: null as { id: string; email?: string; name?: string } | null,
  organizationId: undefined as string | undefined,
}

vi.mock('@/adapters/auth', () => ({
  useAuth: () => ({
    ...authState,
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  }),
}))

vi.mock('@/lib/analytics/posthog', () => ({
  DISABLED_POSTHOG_CONFIG: { host: '', projectToken: '', sessionReplay: false, replaySampleRate: 0, proxy: false },
  initPosthogClient: vi.fn(),
  identifyPosthog: vi.fn(),
  registerPosthogContext: vi.fn(),
  resetPosthog: vi.fn(),
  isPosthogEnabled: vi.fn(() => true),
}))

vi.mock('@/features/layout', () => ({
  useLayoutStore: Object.assign(
    (selector: (state: typeof layoutState) => unknown) => selector(layoutState),
    {
      getState: () => layoutState,
      subscribe: () => () => {},
    }
  ),
}))

vi.mock('@/lib/user-preferences/client', () => ({
  fetchUserPreferences: vi.fn(async () => ({})),
  patchUserPreferences: vi.fn(async () => true),
}))

vi.mock('@/features/chat/store', () => ({
  useChatStore: Object.assign(
    (selector: (state: typeof chatState) => unknown) => selector(chatState),
    {
      getState: () => chatState,
    }
  ),
}))

const baseConfig: AppConfig = {
  authRequired: true,
  fileUpload: {
    acceptedTypes: '.pdf',
    acceptedMimeTypes: ['application/pdf'],
    maxTotalSizeMB: 100,
    maxFileSize: 100 * 1024 * 1024,
    maxIfcFileSize: 0,
    maxTotalSize: 100 * 1024 * 1024,
    maxFileCount: 10,
    fileExpirationCheckIntervalHours: 0,
  },
}

const enabledPosthog = {
  host: 'https://eu.i.posthog.com',
  projectToken: 'phc_test',
  sessionReplay: true,
  replaySampleRate: 1,
  proxy: true,
}

describe('Providers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('renders children inside AuthKitProvider', () => {
    const { container } = render(
      <Providers config={baseConfig} locale="en">
        <div data-testid="content">content</div>
      </Providers>
    )

    expect(container.querySelector('[data-testid="content"]')).toBeInTheDocument()
  })

  test('does not create duplicate interval timers in providers tree', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    render(
      <Providers config={baseConfig} locale="en">
        <div>content</div>
      </Providers>
    )

    expect(setIntervalSpy).not.toHaveBeenCalled()
  })

  describe('theme', () => {
    afterEach(() => {
      layoutState.theme = 'dark'
      document.documentElement.classList.remove('dark')
      document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove())
    })

    // A layout effect, so the class is on <html> before the browser paints the
    // committed tree. React's dev remount strips attributes the inline boot
    // script set; a passive effect let that paint one light frame.
    test('applies the stored theme before paint and points theme-color at it', () => {
      const meta = document.createElement('meta')
      meta.setAttribute('name', 'theme-color')
      meta.setAttribute('content', '#f6f6f4')
      document.head.appendChild(meta)

      render(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      expect(document.documentElement.classList.contains('dark')).toBe(true)
      expect(meta.getAttribute('content')).toBe('#191816')
    })

    test('an explicit light choice removes a dark class the boot script set', () => {
      layoutState.theme = 'light'
      document.documentElement.classList.add('dark')

      render(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })
  })

  describe('PostHog identity', () => {
    const signedInAs = (id: string): void => {
      authState.authRequired = true
      authState.isAuthenticated = true
      authState.user = { id, email: `${id}@example.com`, name: id }
    }

    const signedOut = (): void => {
      authState.authRequired = true
      authState.isAuthenticated = false
      authState.user = null
    }

    afterEach(() => {
      authState.authRequired = false
      authState.isAuthenticated = false
      authState.user = null
      authState.organizationId = undefined
    })

    // The Langfuse audit (docs/observability/langfuse-audit-2026-10.md) flagged
    // identify() sending email and name. The WorkOS user id is the whole identity.
    test('identifies with the WorkOS user id only, never email or name', () => {
      signedInAs('user-a')
      render(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      expect(identifyPosthog).toHaveBeenCalledTimes(1)
      expect(vi.mocked(identifyPosthog).mock.calls[0]).toEqual(['user-a'])
    })

    test('stamps the organization after identifying, and follows an organization switch', () => {
      signedInAs('user-a')
      authState.organizationId = 'org_1'
      const view = render(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )
      expect(registerPosthogContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationId: 'org_1', locale: 'en' })
      )
      expect(vi.mocked(identifyPosthog).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(registerPosthogContext).mock.invocationCallOrder[0]!
      )

      authState.organizationId = 'org_2'
      view.rerender(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )
      expect(registerPosthogContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationId: 'org_2' })
      )
      // A switch inside one session is not a new person.
      expect(identifyPosthog).toHaveBeenCalledTimes(1)
    })

    test('hands the server-known identity to the SDK at init (bootstrap)', () => {
      const identity = {
        distinctId: 'user-a',
        organizationId: 'org_1',
        organizationName: 'Planungsbüro Muster',
        role: 'admin',
        locale: 'de',
      }
      render(
        <Providers config={{ ...baseConfig, posthog: enabledPosthog, posthogIdentity: identity }} locale="de">
          <div>content</div>
        </Providers>
      )
      expect(initPosthogClient).toHaveBeenCalledWith(enabledPosthog, identity)
    })

    test('registers the organization name and role only for the organization the server saw', () => {
      signedInAs('user-a')
      authState.organizationId = 'org_1'
      const identity = {
        distinctId: 'user-a',
        organizationId: 'org_1',
        organizationName: 'Planungsbüro Muster',
        role: 'admin',
        locale: 'en',
      }
      const config = { ...baseConfig, posthog: enabledPosthog, posthogIdentity: identity }
      const view = render(
        <Providers config={config} locale="en">
          <div>content</div>
        </Providers>
      )
      expect(registerPosthogContext).toHaveBeenLastCalledWith({
        organizationId: 'org_1',
        organizationName: 'Planungsbüro Muster',
        role: 'admin',
        locale: 'en',
      })

      // A client-side switch to another organization must not keep the old name.
      authState.organizationId = 'org_2'
      view.rerender(
        <Providers config={config} locale="en">
          <div>content</div>
        </Providers>
      )
      expect(registerPosthogContext).toHaveBeenLastCalledWith({
        organizationId: 'org_2',
        organizationName: null,
        role: null,
        locale: 'en',
      })
    })

    test('does not stamp an organization while signed out', () => {
      signedOut()
      authState.organizationId = 'org_1'
      render(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )
      expect(registerPosthogContext).not.toHaveBeenCalled()
    })

    // A session lost WITHOUT `handleSignOut` — expiry, a failed refresh — used
    // to clear only the local ref. PostHog kept its persisted identity, and
    // because the ref was null the reset-on-user-change guard then did not
    // fire, so the next person to sign in on that browser was identified onto
    // the previous user's distinct id. That is cross-user attribution, so it
    // is pinned here rather than left to review.
    test('resets PostHog when the session is lost without an explicit sign-out', () => {
      signedInAs('user-a')
      const view = render(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )
      expect(identifyPosthog).toHaveBeenCalledWith('user-a')

      signedOut()
      view.rerender(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      expect(resetPosthog).toHaveBeenCalled()
    })

    test('does not identify a new user onto the previous identity', () => {
      signedInAs('user-a')
      const view = render(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      signedOut()
      view.rerender(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      vi.mocked(resetPosthog).mockClear()
      signedInAs('user-b')
      view.rerender(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      // The reset already happened on the way out, so user-b starts clean.
      expect(identifyPosthog).toHaveBeenCalledWith('user-b')
    })

    test('does not reset on a first render that was never authenticated', () => {
      signedOut()
      render(
        <Providers config={baseConfig} locale="en">
          <div>content</div>
        </Providers>
      )

      expect(resetPosthog).not.toHaveBeenCalled()
    })
  })
})
