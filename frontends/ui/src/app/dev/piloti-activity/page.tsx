'use client'

/**
 * Dev preview — „Was Piloti tut", the real section and the real Overview tile
 * on fixtures, with no backend.
 *
 *   /dev/piloti-activity                      every row kind (`full`)
 *   /dev/piloti-activity?variant=empty        Piloti has done nothing here yet
 *   /dev/piloti-activity?variant=waiting-only only the middle section has rows
 *   /dev/piloti-activity?variant=actions      the take-back confirmation open
 *   /dev/piloti-activity?variant=actions&confirm=stop   the stop confirmation open
 *   /dev/piloti-activity?variant=error        the read fails
 *
 * What the shot is for: whether a row reads as a sentence (what, where, for
 * whom); whether „für Sie" and a person the directory does not know are both
 * told apart; whether a failed wake is worded by its class and not by the log
 * line; whether the three sections stay on the page when one is empty; and
 * whether a truncated section says so without a number. Below the section, the
 * Overview tile in its three states.
 *
 * The fetchers are module-stable per variant (the hook re-reads when its
 * fetcher changes) and the actions resolve after a beat, so the re-read after
 * an action can be watched. Pinned to German (`fixedLocale`) because the copy
 * under review is the German copy. 404s outside development (the `/dev` layout).
 */

import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { BentoGrid } from '@/components/ui/bento'
import { I18nProvider } from '@/i18n'
import {
  PilotiActivity,
  type PilotiActivityActions,
} from '@/features/piloti-activity/components/piloti-activity'
import type { PilotiActivityFetcher } from '@/features/piloti-activity/hooks/use-piloti-activity'
import { PilotiTile } from '@/features/projects/components/overview/live-tiles'
import { SettingsSectionIntro } from '@/features/projects/components/settings/settings-panel'
import {
  PILOTI_ACTIVITY_VARIANTS,
  PILOTI_FIXTURE_PROJECT_ID,
  pilotiActivityFixture,
  type PilotiActivityVariant,
} from '../_fixtures/piloti-activity'

const PROJECT_ID = PILOTI_FIXTURE_PROJECT_ID
const beat = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const ACTIONS: PilotiActivityActions = {
  takeBack: () => beat(500),
  stop: () => beat(500),
}

const NEVER: PilotiActivityFetcher = () => new Promise(() => {})
const FAILS: PilotiActivityFetcher = () => Promise.reject(new Error('preview: the read failed'))

function parseVariant(raw: string | null): PilotiActivityVariant {
  return PILOTI_ACTIVITY_VARIANTS.find((variant) => variant === raw) ?? 'full'
}

function Preview({
  variant,
  confirm,
}: {
  variant: PilotiActivityVariant
  confirm: 'takeBack' | 'stop'
}): JSX.Element {
  const now = useMemo(() => new Date(), [])
  const fetcher = useMemo<PilotiActivityFetcher>(() => {
    if (variant === 'error') return FAILS
    const response = pilotiActivityFixture(variant === 'actions' ? 'full' : variant, now)
    return async () => {
      await beat(150)
      return response
    }
  }, [variant, now])
  const ready = useMemo<PilotiActivityFetcher>(() => {
    const response = pilotiActivityFixture('full', now)
    return async () => response
  }, [now])

  return (
    <div className="flex w-full max-w-6xl flex-col gap-10">
      <section className="flex flex-col gap-6" data-testid="piloti-activity-preview-section">
        <SettingsSectionIntro
          title="Was Piloti tut"
          description="Woran Piloti in diesem Projekt arbeitet, was auf Sie oder Ihr Team wartet, und was zuletzt fertig wurde."
        />
        <PilotiActivity
          projectId={PROJECT_ID}
          fetcher={fetcher}
          actions={ACTIONS}
          defaultConfirm={variant === 'actions' ? confirm : undefined}
        />
      </section>

      <section className="flex flex-col gap-3" data-testid="piloti-activity-preview-tile">
        <h2 className="text-foreground text-sm font-semibold">
          Die Kachel in der Übersicht: fertig, lädt, fehlgeschlagen
        </h2>
        <BentoGrid>
          <PilotiTile projectId={PROJECT_ID} href="#section" fetcher={ready} />
          <PilotiTile projectId={PROJECT_ID} href="#section" fetcher={NEVER} />
          <PilotiTile projectId={PROJECT_ID} href="#section" fetcher={FAILS} />
        </BentoGrid>
      </section>
    </div>
  )
}

export default function PilotiActivityPreview(): JSX.Element {
  // Read after mount, not during render: the query string is not available to
  // the server pass, and reading it there mismatches hydration.
  const [params, setParams] = useState<{
    variant: PilotiActivityVariant
    confirm: 'takeBack' | 'stop'
  } | null>(null)
  useEffect(() => {
    const search = new URLSearchParams(window.location.search)
    setParams({
      variant: parseVariant(search.get('variant')),
      confirm: search.get('confirm') === 'stop' ? 'stop' : 'takeBack',
    })
  }, [])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div
        data-testid="piloti-activity-preview"
        className="bg-background flex min-h-screen flex-col items-center p-4 md:p-10"
      >
        {params && (
          <Preview key={params.variant} variant={params.variant} confirm={params.confirm} />
        )}
      </div>
    </I18nProvider>
  )
}
