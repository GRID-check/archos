'use client'

/**
 * Dev preview for the shared project-section chrome on a phone, for any section
 * (`/dev/projects/demo/settings`, `/automation`, `/knowledge`, …): the shell's
 * phone header and tab bar as stand-ins, the real `ProjectSectionFrame` between
 * them, and a marker where the page's own content begins
 * (`data-testid="content-start"`), so a capture can measure how far down the
 * screen the chrome pushes it. Dateien has its own page next door
 * (`../files`), which renders the real workspace.
 *
 * 404s outside development.
 */

import type { JSX } from 'react'
import { use } from 'react'
import { notFound } from 'next/navigation'
import { ProjectSectionFrame } from '@/components/shell/project-section-frame'
import { PRODUCT_NAME } from '@/lib/brand'

export default function ProjectSectionChromeDevPage({
  params,
}: {
  params: Promise<{ section: string }>
}): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()
  const { section } = use(params)
  return (
    <div className="bg-background flex h-dvh flex-col">
      <div className="flex h-14 shrink-0 items-center border-b px-4 text-lg font-semibold">Kaiserstraße 43</div>
      <main className="min-h-0 flex-1">
        <ProjectSectionFrame projectId="demo" projectName="Kaiserstraße 43">
          <div data-testid="content-start" className="p-4 text-sm text-muted-foreground">
            Page content ({section})
          </div>
        </ProjectSectionFrame>
      </main>
      <nav className="text-muted-foreground flex h-[51px] shrink-0 items-center justify-around border-t text-xs">
        <span>Frag {PRODUCT_NAME}</span>
        <span>Dateien</span>
        <span>Übersicht</span>
        <span>Postfach</span>
        <span>Mehr</span>
      </nav>
    </div>
  )
}
