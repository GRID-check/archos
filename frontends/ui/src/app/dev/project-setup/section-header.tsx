'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/ui/page-header'
import { INTAKE_FIXTURES } from '@/app/dev/_fixtures/project-intake'

/**
 * The project section chrome the real page sits under (`ProjectSectionFrame`),
 * without the shell around it, and a row of the fixture states. A state link
 * keeps the step, so one step can be walked through every state.
 */
export function ProjectSectionHeader({ state }: { state: string }) {
  const step = useSearchParams()?.get('step')
  const href = (name: string): string => `/dev/project-setup?state=${name}${step ? `&step=${step}` : ''}`
  return (
    <div className="border-border bg-background border-b px-4 py-4 md:px-8">
      <PageHeader
        title="Projekterfassung"
        subtitle="Piloti liest die Dokumente, Sie prüfen, was es gefunden hat."
        action={
          <nav className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs" aria-label="Fixture">
            {Object.keys(INTAKE_FIXTURES).map((name) => (
              <Link
                key={name}
                href={href(name)}
                aria-current={name === state ? 'page' : undefined}
                className={name === state ? 'text-foreground underline' : 'text-muted-foreground'}
              >
                {name}
              </Link>
            ))}
          </nav>
        }
      />
    </div>
  )
}
