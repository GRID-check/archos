'use client'

/**
 * Dev preview for „Alle Dateien in Ordner einsortieren“, the review step.
 *
 * The real review organism (`RootSortReview`) over fixture data: a three-level
 * architecture folder tree, about forty loose files with sure and unsure
 * placements, two new folder proposals and a few that stay in the root. Every
 * switch and „Verschieben nach …“ works on the fixture; nothing is sent. German,
 * pinned, as the copy is written for the German product.
 *
 * `?variant=unsure` opens it on „Nur unsichere anzeigen“. Not linked from
 * anywhere; the `/dev` layout 404s outside development.
 */

import { use, useMemo, useState, type JSX } from 'react'
import { RootSortReview } from '@/features/documents/components/root-sort/root-sort-review'
import {
  NO_CHANGES,
  type PlacementInput,
  type PlacementState,
} from '@/features/documents/lib/placement-tree'
import { I18nProvider } from '@/i18n'
import { fixtureDocuments, fixtureFolders, fixtureNewFolders, fixturePlacements } from './fixtures'

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
    <div className="border-border bg-background mx-auto max-w-4xl rounded-xl border p-4 shadow-md md:p-6">
      <h1 className="text-base font-semibold">Dateien in Ordner einsortieren</h1>
      <p className="text-muted-foreground mt-1 mb-4 text-sm">
        Piloti schlägt für jede Datei im Stammordner einen Ordner vor. Verschoben wird erst, wenn
        Sie übernehmen.
      </p>
      <RootSortReview
        input={input}
        state={state}
        onStateChange={setState}
        onlyUnsure={onlyUnsure}
        onOnlyUnsureChange={setOnlyUnsure}
      />
    </div>
  )
}

export default function RootSortDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): JSX.Element {
  const onlyUnsure = use(searchParams).variant === 'unsure'
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="bg-background min-h-dvh px-4 py-10 md:px-8">
        <p className="text-muted-foreground mb-4 font-mono text-xs">
          /dev/root-sort{onlyUnsure ? '?variant=unsure' : ''} — Review einer Stammordner-Sortierung
        </p>
        <Review onlyUnsureStart={onlyUnsure} />
      </main>
    </I18nProvider>
  )
}
