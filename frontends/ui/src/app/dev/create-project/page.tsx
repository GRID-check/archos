'use client'

/**
 * The create-project dialog, shown open, so its anatomy is screenshot-
 * reviewable without a database. Submitting calls the real server action and
 * fails without one; the dialog shows its calm error then.
 */

import { CreateProjectDialog } from '@/components/projects/create-project-dialog'

export default function CreateProjectPreviewPage() {
  return (
    <main className="min-h-dvh bg-background px-4 py-10" data-testid="create-project-preview">
      <h1 className="mx-auto mb-6 max-w-lg font-mono text-xs text-muted-foreground">/dev/create-project</h1>
      <CreateProjectDialog defaultOpen />
    </main>
  )
}
