'use client'

/**
 * Dev preview for „Alle Dateien in Ordner einsortieren“. Every state, all from
 * fixtures, no network:
 *
 * - the review (default; `?variant=unsure` opens it on „Nur unsichere anzeigen“):
 *   the real review organism (`RootSortReview`) with a folder tree, sure and
 *   unsure placements, new folder proposals and files that stay in the root;
 * - `?variant=working`: judging, with its count, time left and the files just
 *   placed; `starting` before the first call answers, `waiting` while the job
 *   waits for a slot, `grouping` with its running clock, `applying`;
 * - `?variant=done`: the outcome after files moved.
 *
 * German, pinned, as the copy is written for the German product. Not linked from
 * anywhere; the `/dev` layout 404s outside development.
 */

import type { JSX, ReactNode } from 'react'
import { use, useMemo, useState } from 'react'
import {
  RootSortOutcome,
  RootSortProgress,
  RootSortStages,
} from '@/features/documents/components/root-sort/root-sort-status'
import { RootSortReview } from '@/features/documents/components/root-sort/root-sort-review'
import {
  NO_CHANGES,
  type PlacementInput,
  type PlacementState,
} from '@/features/documents/lib/placement-tree'
import { I18nProvider } from '@/i18n'
import {
  fixtureDocuments,
  fixtureFolders,
  fixtureNewFolders,
  fixtureOutcome,
  fixturePlacements,
  fixtureProgress,
} from './fixtures'

function Shell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="border-border bg-background mx-auto max-w-4xl rounded-xl border p-4 shadow-md md:p-6">
      <h1 className="text-base font-semibold">Dateien in Ordner einsortieren</h1>
      <p className="text-muted-foreground mt-1 mb-4 text-sm">
        Piloti schlägt für jede Datei im Stammordner einen Ordner vor. Verschoben wird erst, wenn
        Sie übernehmen.
      </p>
      {children}
    </div>
  )
}

function Review({ onlyUnsureStart }: { onlyUnsureStart: boolean }): JSX.Element {
  const input = useMemo<PlacementInput>(
    () => ({
      folders: fixtureFolders,
      documents: fixtureDocuments,
      placements: fixturePlacements,
      newFolders: fixtureNewFolders,
    }),
    []
  )
  const [state, setState] = useState<PlacementState>(NO_CHANGES)
  const [onlyUnsure, setOnlyUnsure] = useState(onlyUnsureStart)
  return (
    <Shell>
      <RootSortStages status="ready" />
      <div className="mt-4" />
      <RootSortReview
        input={input}
        state={state}
        onStateChange={setState}
        onlyUnsure={onlyUnsure}
        onOnlyUnsureChange={setOnlyUnsure}
        judgedNothing={false}
      />
    </Shell>
  )
}

export default function RootSortDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): JSX.Element {
  const variant = use(searchParams).variant
  const label = typeof variant === 'string' ? `?variant=${variant}` : ''
  let body: JSX.Element
  const working = typeof variant === 'string' && variant in fixtureProgress ? fixtureProgress[variant as keyof typeof fixtureProgress] : null
  if (working) {
    body = (
      <Shell>
        <RootSortStages status={working.status} />
        <div className="mt-4">
          <RootSortProgress {...working} />
        </div>
      </Shell>
    )
  } else if (variant === 'done') {
    body = (
      <Shell>
        <RootSortStages status="applied" />
        <div className="mt-4" />
        <RootSortOutcome
          moved={fixtureOutcome.moved}
          failedCount={fixtureOutcome.failedCount}
          failedNames={fixtureOutcome.failedNames}
        />
      </Shell>
    )
  } else {
    body = <Review onlyUnsureStart={variant === 'unsure'} />
  }
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="bg-background min-h-dvh px-4 py-10 md:px-8">
        <p className="text-muted-foreground mb-4 font-mono text-xs">
          /dev/root-sort{label} — Stammordner-Sortierung
        </p>
        {body}
      </main>
    </I18nProvider>
  )
}
