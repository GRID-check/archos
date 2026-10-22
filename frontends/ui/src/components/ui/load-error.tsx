'use client'

import * as React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { BusyButton } from '@/components/ui/busy-button'
import { useTranslations } from '@/i18n'

export interface LoadErrorProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /**
   * What failed to load, in the surface's own words („Budgets konnten nicht
   * geladen werden"). Falls back to a generic sentence; a surface that can say
   * WHAT failed should.
   */
  title?: React.ReactNode
  /** A quieter second line: why, or what the reader can do besides retrying. */
  description?: React.ReactNode
  /**
   * Loads again. When it returns a promise the button stays busy until the
   * promise settles, so a caller whose load is async gets the busy state free.
   * Without it the block says what failed and offers nothing.
   */
  onRetry?: () => unknown
  /** The retry is in flight, for a caller that tracks its own load. Wins over the promise. */
  retrying?: boolean
  /** Further actions after the retry (clear the filters that made the query fail). */
  actions?: React.ReactNode
}

/**
 * „That did not load — try again": the one block for a load that failed where
 * its content should be.
 *
 * Before this, every surface composed `Alert` + `Button` by hand, and they had
 * drifted three ways: some named the failure in the title and some in the
 * description, some had a glyph, and the platform ones `disabled` the retry
 * while it ran, which blurs a focused button in Chrome. Here the shape is fixed
 * (destructive alert, warning glyph, the failure as the title, an optional
 * hint, then the retry) and the retry is a `BusyButton`: busy is not disabled,
 * so the control keeps its focus and width, swallows a second press, and shows
 * „Wird erneut geladen …" only once the wait passes 150 ms.
 *
 * For a load failure where content should be. A failed ACTION is a toast, and
 * a failed field is the form's inline error (design language, „Error").
 */
export const LoadError = React.forwardRef<HTMLDivElement, LoadErrorProps>(
  ({ title, description, onRetry, retrying, actions, ...props }, ref) => {
    const t = useTranslations('common')
    const [pending, setPending] = React.useState(false)
    const busy = retrying ?? pending

    const retry = (): void => {
      const result = onRetry?.()
      if (!(result instanceof Promise)) return
      setPending(true)
      // A rejected retry is the caller's to report (it renders this block
      // again); here it only ends the busy state.
      void result.catch(() => undefined).finally(() => setPending(false))
    }

    return (
      <Alert ref={ref} variant="destructive" data-slot="load-error" {...props}>
        <AlertTriangle aria-hidden />
        <AlertTitle className="line-clamp-none">{title ?? t('loadError.title')}</AlertTitle>
        {description || onRetry || actions ? (
          <AlertDescription>
            {description ? <p>{description}</p> : null}
            {onRetry || actions ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {onRetry ? (
                  <BusyButton
                    variant="outline"
                    size="sm"
                    busy={busy}
                    busyLabel={t('loadError.retrying')}
                    icon={<RefreshCw aria-hidden />}
                    onClick={retry}
                    data-testid="load-error-retry"
                  >
                    {t('loadError.retry')}
                  </BusyButton>
                ) : null}
                {actions}
              </div>
            ) : null}
          </AlertDescription>
        ) : null}
      </Alert>
    )
  }
)
LoadError.displayName = 'LoadError'
