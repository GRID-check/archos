'use client'

/**
 * „Herauslösen …“ (D34): a mail filed into the wrong E-Mail-Verlauf moves into
 * another one, or into a new one in the same folder.
 *
 * The confirmation says what the move does before it does it, because it is
 * the one recorded exception to „Fassung N+1 holds every section of N“: the
 * earlier Fassungen that keep the mail are named by number („Fassung 4 bis 6
 * behalten diese E-Mail“), and the Fassung this thread gets without it. Every
 * follow of this thread ends, and it says so.
 *
 * One call (`mail-thread-entry-detach`). A refusal (`MAIL_THREAD_REFUSALS`:
 * the thread's only mail, a thread being written, a target gone or full, a
 * name stopped or taken) is said inside the dialog, which stays open so the
 * person can choose again.
 */

import type { JSX } from 'react'
import { useEffect, useId, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTranslations } from '@/i18n'
import type {
  MailThreadEntryDetachBody,
  MailThreadEntryDetachResultView,
  MailThreadEntryView,
  MailThreadSummaryView,
  MailThreadView,
} from '@/lib/mail-thread/mail-thread-wire'
import type { MailThreadClient } from './client'
import { detachKeeps } from './mail-thread-model'
import { refusalKey, type MailThreadRefusalKey } from './refusal'

/** The longest name a new thread takes (`mailThreadEntryDetachBodySchema`). */
const NEW_THREAD_NAME_MAX = 240

type Targets = { kind: 'loading' } | { kind: 'ready'; threads: MailThreadSummaryView[] } | { kind: 'failed' }

export interface DetachDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  thread: MailThreadView
  entry: MailThreadEntryView
  /** The thread document's current Fassung, for the confirmation's numbers. */
  currentVersion: number | null
  /** The thread document's folder: a new thread goes beside it (null is the project's root). */
  folderId: string | null
  client: MailThreadClient
  onDetached: (result: MailThreadEntryDetachResultView, targetName: string | null) => void
}

export function DetachDialog({ open, onOpenChange, projectId, thread, entry, currentVersion, folderId, client, onDetached }: DetachDialogProps): JSX.Element {
  const t = useTranslations('mailThread')
  const id = useId()
  const [targets, setTargets] = useState<Targets>({ kind: 'loading' })
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [threadId, setThreadId] = useState<string>('')
  const [name, setName] = useState('')
  const [refusal, setRefusal] = useState<MailThreadRefusalKey | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    setRefusal(null)
    setName('')
    setThreadId('')
    setTargets({ kind: 'loading' })
    client
      .list(projectId)
      .then((page) => {
        if (!alive) return
        const threads = page.items.filter((candidate) => candidate.id !== thread.id)
        setTargets({ kind: 'ready', threads })
        setMode(threads.length > 0 ? 'existing' : 'new')
      })
      .catch(() => {
        if (!alive) return
        setTargets({ kind: 'failed' })
        setMode('new')
      })
    return () => {
      alive = false
    }
  }, [client, open, projectId, thread.id])

  const keeps = detachKeeps(entry, currentVersion)
  const threads = targets.kind === 'ready' ? targets.threads : []
  const trimmed = name.trim()
  const ready = mode === 'existing' ? threadId !== '' : trimmed !== ''

  const confirm = async (): Promise<void> => {
    const body: MailThreadEntryDetachBody =
      mode === 'existing'
        ? { target: { action: 'append', mailThreadId: threadId } }
        : { target: { action: 'create', name: trimmed, ...(folderId ? { folderId } : {}) } }
    setRefusal(null)
    try {
      const result = await client.detach(projectId, thread.id, entry.id, body)
      onDetached(result, mode === 'existing' ? (threads.find((candidate) => candidate.id === threadId)?.name ?? null) : trimmed)
    } catch (error) {
      setRefusal(refusalKey(error))
      // Rethrown so the dialog stays open with the refusal in it.
      throw error
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="warning"
      title={t('detach.title')}
      description={t('detach.description', { heading: entry.heading })}
      confirmLabel={t('detach.confirm')}
      cancelLabel={t('detach.cancel')}
      onConfirm={confirm}
      confirmDisabled={!ready}
      confirmTestId="mail-thread-detach-confirm"
    >
      <div className="flex flex-col gap-4 text-sm" data-testid="mail-thread-detach">
        <div className="flex flex-col gap-1.5">
          {keeps && (
            <p data-testid="mail-thread-detach-keeps">
              {keeps.first === keeps.last
                ? t('detach.keepsOne', { first: keeps.first, next: keeps.next })
                : t('detach.keeps', { first: keeps.first, last: keeps.last, next: keeps.next })}
            </p>
          )}
          {thread.follows.length > 0 && <p className="text-muted-foreground">{t('detach.followsEnd')}</p>}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('detach.target')}</legend>
          <RadioGroup value={mode} onValueChange={(value) => setMode(value === 'new' ? 'new' : 'existing')}>
            <div className="flex items-center gap-2 pointer-coarse:min-h-11">
              <RadioGroupItem id={`${id}-existing`} value="existing" disabled={threads.length === 0} />
              <Label htmlFor={`${id}-existing`} className="font-normal">
                {t('detach.toExisting')}
              </Label>
            </div>
            {mode === 'existing' && (
              <div className="pl-6">
                {targets.kind === 'loading' ? (
                  <p className="text-muted-foreground text-xs" role="status">
                    {t('detach.loadingTargets')}
                  </p>
                ) : (
                  <Select value={threadId} onValueChange={setThreadId}>
                    <SelectTrigger aria-label={t('detach.existing')} className="w-full pointer-coarse:text-base" data-testid="mail-thread-detach-target">
                      <SelectValue placeholder={t('detach.choose')} />
                    </SelectTrigger>
                    <SelectContent>
                      {threads.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id} className="[overflow-wrap:anywhere]">
                          {candidate.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
            {targets.kind === 'ready' && threads.length === 0 && (
              <p className="text-muted-foreground pl-6 text-xs">{t('detach.noOther')}</p>
            )}
            <div className="flex items-center gap-2 pointer-coarse:min-h-11">
              <RadioGroupItem id={`${id}-new`} value="new" />
              <Label htmlFor={`${id}-new`} className="font-normal">
                {t('detach.toNew')}
              </Label>
            </div>
            {mode === 'new' && (
              <Field className="pl-6">
                <FieldLabel htmlFor={`${id}-name`}>{t('detach.name')}</FieldLabel>
                <Input
                  id={`${id}-name`}
                  value={name}
                  maxLength={NEW_THREAD_NAME_MAX}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                  enterKeyHint="done"
                  className="pointer-coarse:text-base"
                  aria-describedby={`${id}-name-hint`}
                  data-testid="mail-thread-detach-name"
                />
                <p id={`${id}-name-hint`} className="text-muted-foreground text-xs">
                  {t('detach.nameHint')}
                </p>
              </Field>
            )}
          </RadioGroup>
        </fieldset>

        {refusal && (
          <Alert data-testid="mail-thread-detach-refusal" data-reason={refusal}>
            <AlertTriangle aria-hidden className="text-warning" />
            <AlertTitle className="line-clamp-none font-normal">{t(`refusals.${refusal}`)}</AlertTitle>
          </Alert>
        )}
      </div>
    </ConfirmDialog>
  )
}
