'use client'

/**
 * Dev preview of the workspace atoms (`ui/components/ui`), grouped by job, so
 * the radius rule reads at a glance: controls 4px, surfaces square, round only
 * where the thing is round (avatars, dots, radio and switch knobs). Fixture
 * props only, no data. Not linked from anywhere; 404s outside development.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { ControlsSection } from './controls-section'
import { StatusSection } from './status-section'
import { SurfacesSection } from './surfaces-section'

export default function AtomsDevPage(): JSX.Element {
  const [dark, setDark] = useState(false)

  const toggleTheme = (): void => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 bg-background p-4 text-foreground sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Atoms</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every atom in ui/components/ui, grouped by job. Controls: 4px. Surfaces: square.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          className="inline-flex h-9 items-center border border-border px-3 text-sm font-medium"
        >
          {dark ? 'Light theme' : 'Dark theme'}
        </button>
      </div>
      <ControlsSection />
      <StatusSection />
      <SurfacesSection />
    </main>
  )
}
