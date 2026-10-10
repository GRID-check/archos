'use client'

/**
 * Moving a project through its lifecycle (ADR-0098), from wherever the move is
 * offered: the status card on the Overview, the hero's menu, the banner every
 * page of a paused or closed project opens with. One hook, so the three ask the
 * same questions and say the same things.
 *
 *   - **Pause** and **resume** ask nothing: neither changes who may do what,
 *     and each is undone by the other. Pausing offers the undo in its toast.
 *   - **Close** opens the closing dialog (`close-project-dialog.tsx`): how it
 *     ended and when, what the office keeps, what goes to the Papierkorb.
 *   - **Reopen** asks once, because it takes the project away from everyone in
 *     the office who is not a member.
 *
 * The server decides and audits (`PUT /api/projects/[id]/status`); the hook
 * only asks and then refreshes the page, whose every section reads the new
 * state from the server.
 */

import { useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTranslations } from '@/i18n'
import type { ProjectProfile } from '@/lib/project-profile/types'
import type { ProjectLifecycleView, ProjectOutcome } from '@/lib/projects/project-status'
import type { Month } from '@/lib/projects/month'
import { CloseProjectDialog } from '../components/close-project-dialog'
import { ClosingDebrief } from '../components/closing-debrief'

export interface UseProjectLifecycleOptions {
  projectId: string
  lifecycle: ProjectLifecycleView
  /** The profile, for the closing debrief's fingerprint. */
  profile?: ProjectProfile | null
  /** Whether the closer may confirm decisions and record a lesson in the debrief. */
  canWriteMemory?: boolean
}

export interface ProjectLifecycleControls {
  pause: () => Promise<void>
  resume: () => Promise<void>
  requestClose: () => void
  requestReopen: () => void
  pending: boolean
  /** The dialogs the moves open; render once, anywhere in the caller's tree. */
  dialogs: ReactNode
}

/** What a close names: how the project ended, and its Abschluss month. */
export interface ClosingChoice {
  outcome: ProjectOutcome
  endedOn: Month
}

type Body = { status: 'active' } | { status: 'paused' } | ({ status: 'closed' } & ClosingChoice)

export function useProjectLifecycle({
  projectId,
  lifecycle,
  profile = null,
  canWriteMemory = false,
}: UseProjectLifecycleOptions): ProjectLifecycleControls {
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [closing, setClosing] = useState(false)
  const [reopening, setReopening] = useState(false)
  const [pending, setPending] = useState(false)

  const move = async (body: Body, done: string): Promise<boolean> => {
    setPending(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/status`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(String(res.status))
      toast.success(done, body.status === 'paused' ? { action: { label: t('lifecycle.toast.undo'), onClick: () => void resume() } } : undefined)
      router.refresh()
      return true
    } catch {
      toast.error(t('lifecycle.toast.error'))
      return false
    } finally {
      setPending(false)
    }
  }

  const resume = async (): Promise<void> => {
    await move({ status: 'active' }, t('lifecycle.toast.resumed'))
  }

  const close = async (choice: ClosingChoice): Promise<boolean> => {
    const ok = await move({ status: 'closed', ...choice }, t('lifecycle.toast.closed'))
    if (ok) setClosing(false)
    return ok
  }

  const dialogs = (
    <>
      {lifecycle.status !== 'closed' && (
        <CloseProjectDialog projectId={projectId} lifecycle={lifecycle} open={closing} onOpenChange={setClosing} onClose={close}>
          {closing && (
            <ClosingDebrief projectId={projectId} profile={profile} startedOn={lifecycle.startedOn} canWriteMemory={canWriteMemory} />
          )}
        </CloseProjectDialog>
      )}
      {lifecycle.status === 'closed' && (
        <ConfirmDialog
          open={reopening}
          onOpenChange={setReopening}
          tone="default"
          title={t('lifecycle.reopenDialog.title')}
          description={t('lifecycle.reopenDialog.description')}
          confirmLabel={t('lifecycle.reopenDialog.confirm')}
          cancelLabel={tCommon('actions.cancel')}
          onConfirm={async () => {
            if (await move({ status: 'active' }, t('lifecycle.toast.reopened'))) setReopening(false)
          }}
          pending={pending}
        />
      )}
    </>
  )

  return {
    pause: async () => {
      await move({ status: 'paused' }, t('lifecycle.toast.paused'))
    },
    resume,
    requestClose: () => setClosing(true),
    requestReopen: () => setReopening(true),
    pending,
    dialogs,
  }
}
