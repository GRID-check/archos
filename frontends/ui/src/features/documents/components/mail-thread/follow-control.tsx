'use client'

/**
 * „Verlauf folgen“ in the „E-Mails“ tab (D31, D10): the viewer's own standing
 * decision about this thread, and for a project manager everybody's.
 *
 * - **Following:** „Sie folgen diesem E-Mail-Verlauf bis 21.12.2026“ with
 *   „Verlängern“ (only while the follow can still grow: 180 days from its
 *   start is the most) and „Nicht mehr folgen“.
 * - **Not following**, for whoever may file mail here: what following does,
 *   in one line, and „Diesem E-Mail-Verlauf folgen“. The toast it leaves
 *   carries the undo.
 * - **Others:** a count for everybody; for a viewer who `managesFollows`, the
 *   followers by name with „Beenden“ each. Nobody else ever sees „Beenden“
 *   on someone else's follow, and the route refuses it anyway.
 *
 * Every press is one call of the thread's client (`mail-thread-follow`,
 * `mail-thread-unfollow`), then the tab reads the thread again: the server's
 * answer is the state, never a local guess.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Repeat2, UserRound } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { useLocale, useTranslations } from '@/i18n'
import { formatCalendarDate } from '@/lib/format'
import type { MailThreadFollowView, MailThreadView } from '@/lib/mail-thread/mail-thread-wire'
import { cn } from '@/lib/utils'
import type { MailThreadClient } from './client'
import { mayEndFollow, mayWrite, otherFollows, viewerFollow } from './mail-thread-model'
import { refusalKey } from './refusal'

export interface FollowControlProps {
  projectId: string
  view: MailThreadView
  viewerUserId: string | null
  client: MailThreadClient
  /** A follow changed: read the thread again. */
  onChanged: () => void
  className?: string
}

type Pending = 'follow' | 'renew' | 'unfollow' | `end:${string}` | null

export function FollowControl({ projectId, view, viewerUserId, client, onChanged, className }: FollowControlProps): JSX.Element | null {
  const t = useTranslations('mailThread')
  const { locale } = useLocale()
  const [pending, setPending] = useState<Pending>(null)
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map())
  const own = viewerFollow(view, viewerUserId)
  const others = otherFollows(view, viewerUserId)
  const manages = view.managesFollows && others.length > 0

  // A manager reads the followers by name; the roster is theirs to read (`project:manage`).
  useEffect(() => {
    if (!manages) return
    let alive = true
    client
      .people(projectId)
      .then((people) => {
        if (alive) setNames(new Map(people.map((person) => [person.userId, person.name])))
      })
      .catch(() => {
        // Without names the rows say „Ein Projektmitglied“; „Beenden“ still works.
      })
    return () => {
      alive = false
    }
  }, [client, manages, projectId])

  const date = (iso: string) => formatCalendarDate(iso, locale)
  const fail = (error: unknown) => toast.error(t(`refusals.${refusalKey(error)}`))

  const run = async (which: Exclude<Pending, null>, action: () => Promise<void>): Promise<void> => {
    setPending(which)
    try {
      await action()
      onChanged()
    } catch (error) {
      fail(error)
    } finally {
      setPending(null)
    }
  }

  const follow = () =>
    run('follow', async () => {
      const result = await client.follow(projectId, view.id)
      toast.success(t('follow.followed', { name: view.name, date: date(result.follow.expiresAt) }), {
        action: {
          label: t('follow.undo'),
          onClick: () => void client.unfollow(projectId, view.id).then(onChanged, fail),
        },
      })
    })
  const renew = () =>
    run('renew', async () => {
      const result = await client.follow(projectId, view.id)
      toast.success(t('follow.renewed', { date: date(result.follow.expiresAt) }))
    })
  const unfollow = () =>
    run('unfollow', async () => {
      await client.unfollow(projectId, view.id)
      toast.success(t('follow.unfollowed', { name: view.name }))
    })
  const end = (follow: MailThreadFollowView, name: string) =>
    run(`end:${follow.userId}`, async () => {
      await client.unfollow(projectId, view.id, { userId: follow.userId })
      toast.success(t('follow.ended', { name }))
    })

  const canFollow = own.kind === 'none' && mayWrite(view)
  if (own.kind === 'none' && !canFollow && others.length === 0) return null

  return (
    <section className={cn('bg-card flex flex-col gap-2.5 rounded-lg border p-3', className)} data-testid="mail-thread-follow" data-following={own.kind === 'following' || undefined}>
      <div className="flex min-w-0 items-start gap-2.5">
        <Repeat2 className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium [overflow-wrap:anywhere]" data-testid="mail-thread-follow-state">
            {own.kind === 'following'
              ? own.follow
                ? t('follow.following', { date: date(own.follow.expiresAt) })
                : t('follow.followingUndated')
              : t('follow.offer')}
          </p>
          {own.kind === 'none' && canFollow && <p className="text-muted-foreground text-xs leading-snug">{t('follow.explain')}</p>}
          {own.kind === 'following' && own.follow && !own.renewable && (
            <p className="text-muted-foreground text-xs leading-snug" data-testid="mail-thread-follow-limit">
              {t('follow.renewLimit')}
            </p>
          )}
        </div>
      </div>

      {(canFollow || own.kind === 'following') && (
        <div className="flex flex-wrap gap-2">
          {canFollow && (
            <BusyButton type="button" size="sm" variant="outline" busy={pending === 'follow'} busyLabel={t('follow.offer')} onClick={() => void follow()} data-testid="mail-thread-follow-start">
              {t('follow.offer')}
            </BusyButton>
          )}
          {own.kind === 'following' && own.renewable && (
            <BusyButton type="button" size="sm" variant="outline" busy={pending === 'renew'} busyLabel={t('follow.renew')} onClick={() => void renew()} data-testid="mail-thread-follow-renew">
              {t('follow.renew')}
            </BusyButton>
          )}
          {own.kind === 'following' && (
            <BusyButton type="button" size="sm" variant="ghost" busy={pending === 'unfollow'} busyLabel={t('follow.unfollow')} onClick={() => void unfollow()} data-testid="mail-thread-follow-stop">
              {t('follow.unfollow')}
            </BusyButton>
          )}
        </div>
      )}

      {others.length > 0 && !view.managesFollows && (
        <p className="text-muted-foreground text-xs" data-testid="mail-thread-follow-others">
          {t('follow.others', { count: others.length })}
        </p>
      )}

      {manages && (
        <div className="flex flex-col gap-1 border-t pt-2.5" data-testid="mail-thread-followers">
          <p className="text-muted-foreground text-xs font-medium">{t('follow.followers')}</p>
          <ul className="flex flex-col">
            {others.map((follow) => {
              const name = names.get(follow.userId) ?? t('follow.someone')
              return (
                <li key={follow.id} className="flex min-w-0 items-center gap-2 py-1 pointer-coarse:min-h-11" data-testid="mail-thread-follower">
                  <UserRound className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 text-xs">
                    <span className="font-medium [overflow-wrap:anywhere]">{name}</span>{' '}
                    <span className="text-muted-foreground tabular-nums">{t('follow.follower', { date: date(follow.expiresAt) })}</span>
                  </span>
                  {mayEndFollow(view, follow, viewerUserId) && (
                    <BusyButton
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 px-2 text-xs"
                      busy={pending === `end:${follow.userId}`}
                      busyLabel={t('follow.end')}
                      aria-label={t('follow.endLabel', { name })}
                      onClick={() => void end(follow, name)}
                      data-testid="mail-thread-follower-end"
                    >
                      {t('follow.end')}
                    </BusyButton>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
