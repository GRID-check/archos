/**
 * The usage notice where the chat shows it: above the composer, for the person
 * signed in. Reads and refreshes through `useUsageNotice`, remembers a
 * dismissal per notice key (scope, window and level, so the next level or the
 * next window shows again), and reports both moments to PostHog.
 */

'use client'

import { type FC, useEffect, useRef, useState } from 'react'
import { capturePosthog } from '@/lib/analytics/posthog'
import { useChatStore } from '../store'
import { readDismissedNotices, rememberDismissedNotice, useUsageNotice } from '../hooks/use-usage-notice'
import { UsageNotice } from './UsageNotice'

export const ChatUsageNotice: FC<{ isAuthenticated?: boolean }> = ({ isAuthenticated = false }) => {
  const projectId = useChatStore((state) => state.projectId)
  const isStreaming = useChatStore((state) => state.isStreaming)
  const notice = useUsageNotice({ enabled: isAuthenticated, projectId: projectId ?? null, isStreaming })

  const [dismissed, setDismissed] = useState<readonly string[]>([])
  useEffect(() => setDismissed(readDismissedNotices()), [])

  const visible = notice && (notice.level === 'exhausted' || !dismissed.includes(notice.key)) ? notice : null

  // Once per notice per page view: a refresh that finds the same notice is not a second sighting.
  const announced = useRef(new Set<string>())
  useEffect(() => {
    if (!visible || announced.current.has(visible.key)) return
    announced.current.add(visible.key)
    capturePosthog('usage_notice_shown', {
      level: visible.level,
      scope: visible.scope,
      window: visible.window,
      unit: visible.unit,
      can_change: visible.canChange,
    })
  }, [visible])

  if (!visible) return null

  const dismiss = (): void => {
    rememberDismissedNotice(visible.key)
    setDismissed((current) => [...current, visible.key])
    capturePosthog('usage_notice_dismissed', { level: visible.level, scope: visible.scope, window: visible.window })
  }

  return (
    <div className="not-first:pt-2 animate-in fade-in-0 slide-in-from-bottom-1 mx-auto w-full max-w-5xl px-4 sm:px-6 duration-base ease-entrance motion-reduce:animate-none">
      <UsageNotice notice={visible} onDismiss={visible.level === 'exhausted' ? undefined : dismiss} />
    </div>
  )
}
