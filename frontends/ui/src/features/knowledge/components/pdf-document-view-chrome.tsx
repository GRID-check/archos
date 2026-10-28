import { useState, type FC, type JSX, type ReactNode } from 'react'

import { AlertTriangle, Check, ExternalLink, LockKeyhole, Quote, RotateCcw, TextSearch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

import { Input } from '@/components/ui/input'

import { cn } from '@/lib/utils'

import { capturePosthog } from '@/lib/analytics/posthog'
import { useTranslations } from '@/i18n'
import { knowledgeCopy } from '@/i18n/namespaces/knowledge'

import { QuoteSelection } from './pdf-document-view-helpers'

/** The ground when the host lays its own: layout only, no material. */
export function HostGround({ className, children }: { className?: string; children?: ReactNode }): JSX.Element {
  return <div className={cn('relative min-h-0 min-w-0', className)}>{children}</div>
}

/**
 * pdf.js could not open the document: a blocked worker, a corrupt file, a
 * stream that refused. Said on the stage, where the document would have been,
 * with the two things a reader can do about it — try again, or hand the file to
 * the browser's own viewer, which still honours `#page=N` and reads things
 * pdf.js will not. Not a frame of that viewer in place of this one: a frame is
 * what shows blank on Android Chrome, which has no inline PDF renderer.
 */
export const PdfFailure: FC<{ href: string; onRetry: () => void }> = ({ href, onRetry }) => {
  const t = useTranslations(knowledgeCopy)
  return (
    <EmptyState
      variant="bare"
      icon={AlertTriangle}
      tone="warning"
      title={t('viewer.failedTitle')}
      description={t('viewer.failedBody')}
      data-testid="pdf-load-failed"
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RotateCcw aria-hidden />
            {t('viewer.retry')}
          </Button>
          <Button asChild variant="ghost" size="sm">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => capturePosthog('document_opened', { kind: 'pdf', library: 'browser' })}
            >
              <ExternalLink aria-hidden />
              {t('viewer.openInBrowser')}
            </a>
          </Button>
        </div>
      }
    />
  )
}

/**
 * The document is encrypted. Ask for its password here, on the stage, rather
 * than calling it a failure: the office has the password, usually in the email
 * the document came with. The password goes to pdf.js and nowhere else — not
 * to the server, not into storage — and is forgotten with the viewer.
 */
export const PdfPasswordPrompt: FC<{ incorrect: boolean; onSubmit: (password: string) => void }> = ({
  incorrect,
  onSubmit,
}) => {
  const t = useTranslations(knowledgeCopy)
  const [value, setValue] = useState('')
  return (
    <EmptyState
      variant="bare"
      icon={LockKeyhole}
      title={t('viewer.passwordTitle')}
      description={t('viewer.passwordBody')}
      data-testid="pdf-password"
      action={
        <form
          className="flex w-full max-w-xs flex-col items-stretch gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (value) onSubmit(value)
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            enterKeyHint="go"
            aria-label={t('viewer.passwordLabel')}
            placeholder={t('viewer.passwordLabel')}
            aria-invalid={incorrect || undefined}
            aria-describedby={incorrect ? 'pdf-password-error' : undefined}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {incorrect && (
            <p id="pdf-password-error" role="alert" className="text-destructive text-left text-xs">
              {t('viewer.passwordIncorrect')}
            </p>
          )}
          <Button type="submit" size="sm" disabled={!value}>
            {t('viewer.passwordSubmit')}
          </Button>
        </form>
      }
    />
  )
}

/**
 * The offer that turns a selection into a citation.
 *
 * Anchored to the selection rather than parked in the toolbar, because the
 * gesture and the offer belong together: the reader has just dragged across a
 * sentence and their eyes are on it. One action, in the reader's own language
 * of what they are doing — not "copy text", which the browser already does,
 * but "copy this AS A CITATION", with the document and page the viewer knows
 * and their clipboard otherwise would not.
 *
 * `onMouseDown` is prevented on purpose: the default would move focus and
 * collapse the very selection the button exists to act on, so the click would
 * copy nothing.
 */
export const QuoteBar: FC<{
  selection: QuoteSelection
  state: 'idle' | 'done' | 'failed'
  /** Copy the selection as a citation; absent where the viewer is not citing anything. */
  onCopy?: () => void
  /** Look for passages like the selection; absent where nobody asked for it, or the selection is too short. */
  onFindSimilar?: () => void
}> = ({ selection, state, onCopy, onFindSimilar }) => {
  const t = useTranslations(knowledgeCopy)
  const label =
    state === 'done'
      ? t('viewer.quoteCopied')
      : state === 'failed'
        ? t('viewer.copyFailed')
        : t('viewer.copyQuote')
  return (
    <div
      data-testid="pdf-quote-bar"
      className="absolute z-10 -translate-y-full pb-1.5"
      // Clamped at the left edge: a selection that starts in the page's gutter
      // would otherwise hang the bar outside the frame and clip it.
      style={{ left: Math.max(0, selection.x), top: selection.y }}
    >
      <span className="flex items-center gap-1.5">
        {onCopy && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onCopy}
            // `bg-card` is load-bearing, not decoration: the outline variant is
            // transparent, and this bar floats over the rendered PAGE, which is
            // paper-white in both themes. In dark mode that put near-white label
            // text on white paper — a control that was, measurably, invisible
            // exactly where it is offered.
            className="bg-card shadow-sm"
          >
            {state === 'done' ? (
              <Check aria-hidden className="size-3.5" />
            ) : (
              <Quote aria-hidden className="size-3.5" />
            )}
            {label}
          </Button>
        )}
        {onFindSimilar && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onFindSimilar}
            // On paper-white, as the copy button beside it (see `bg-card` above).
            className="bg-card shadow-sm"
            data-testid="pdf-find-similar"
          >
            <TextSearch aria-hidden className="size-3.5" />
            {t('viewer.findSimilar')}
          </Button>
        )}
      </span>
    </div>
  )
}
