import { PageHeader } from '@/components/ui/page-header'

/** The project section chrome the real page sits under (`ProjectSectionFrame`), without the shell around it. */
export function ProjectSectionHeader({ state }: { state: string }) {
  return (
    <div className="border-border bg-background border-b px-4 py-4 md:px-8">
      <PageHeader
        title="Projekterfassung"
        subtitle="Piloti liest die Dokumente, Sie prüfen, was es gefunden hat."
        action={<span className="text-muted-foreground font-mono text-xs">/dev/project-setup?state={state}</span>}
      />
    </div>
  )
}
