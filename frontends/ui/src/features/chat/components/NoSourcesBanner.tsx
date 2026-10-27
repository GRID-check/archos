/**
 * NoSourcesBanner Component
 *
 * Displays a warning banner when no data sources are enabled and no files
 * are available for the current session. This alerts users that responses
 * may be less accurate without external data sources.
 *
 * Auto-hides when:
 * - Any data source is enabled (e.g., web search or internal knowledge)
 * - At least one file is available (status === 'success')
 *
 * Dismissable by user. Dismiss state resets when conditions improve
 * (sources/files become available) so the banner can reappear if the
 * user later removes all sources and files.
 */

'use client'

import { type FC, useState, useEffect, useRef } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AnimatePresence } from '@/components/motion'
import { HeightArrival } from '@/components/motion/height-arrival'
import { useTranslations } from '@/i18n'
import { useLayoutStore } from '@/features/layout/store'
import { useDocumentsStore } from '@/features/documents/store'
import { useChatStore } from '../store'

/**
 * Warning banner shown when no data sources or files are available.
 * Self-contained: reads state from layout, documents, and chat stores.
 */
interface NoSourcesBannerProps {
  isAuthenticated?: boolean
}

export const NoSourcesBanner: FC<NoSourcesBannerProps> = ({ isAuthenticated = false }) => {
  const t = useTranslations('chat')
  const [isDismissedByUser, setIsDismissedByUser] = useState(false)

  const enabledDataSourceIds = useLayoutStore((state) => state.enabledDataSourceIds)
  const knowledgeLayerAvailable = useLayoutStore((state) => state.knowledgeLayerAvailable)
  const sessionId = useChatStore((state) => state.currentConversation?.id)

  // Get completed files for the current session from the documents store
  const hasAvailableFiles = useDocumentsStore((state) =>
    state.trackedFiles.some(
      (f) => f.collectionName === sessionId && f.status === 'success'
    )
  )

  const hasAnySources = enabledDataSourceIds.length > 0 || knowledgeLayerAvailable
  const shouldShow = !hasAnySources && !hasAvailableFiles

  // Track previous shouldShow to detect when conditions improve.
  // When the warning condition clears (sources/files become available),
  // reset the dismiss state so the banner can reappear if conditions worsen again.
  const prevShouldShowRef = useRef(shouldShow)

  useEffect(() => {
    const prev = prevShouldShowRef.current
    // Conditions improved: was showing (or would show) -> now resolved
    if (prev && !shouldShow) {
      setIsDismissedByUser(false)
    }
    prevShouldShowRef.current = shouldShow
  }, [shouldShow])

  const handleDismiss = () => {
    setIsDismissedByUser(true)
  }

  const visible = isAuthenticated && shouldShow && !isDismissedByUser

  // No CSS entrance on the root: it replayed on every mount of the composer
  // stack (each page load, each project). A banner standing when the composer
  // mounts stands; one that turns up later, or is dismissed, takes its height
  // smoothly so the stack above the input does not jump.
  return (
    <AnimatePresence initial={false}>
      {visible && (
        <HeightArrival key="no-sources" className="mx-auto w-full max-w-5xl px-4 sm:px-6">
          <Alert variant="warning" className="relative">
            <AlertTriangle />
            <AlertDescription className="pr-6">{t('noSources.warning')}</AlertDescription>
            <button
              type="button"
              onClick={handleDismiss}
              aria-label={t('actions.dismiss')}
              className="text-muted-foreground hover:text-foreground duration-quick absolute right-3 top-3 rounded-xs transition-colors ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </Alert>
        </HeightArrival>
      )}
    </AnimatePresence>
  )
}
