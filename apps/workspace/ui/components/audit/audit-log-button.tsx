'use client'

/**
 * Opens the native WorkOS Admin Portal audit-log viewer. Each click mints a
 * fresh short-lived, org-scoped portal link via the given endpoint (POST) —
 * links are single-use sessions, so nothing is prefetched or cached.
 */

import { type FC, useState } from 'react'
import { ExternalLink, ScrollText } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { useDelayedFlag } from '@/hooks/use-transient-flag'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

interface AuditLogButtonProps {
  endpoint: string
  label: string
  errorMessage: string
}

export const AuditLogButton: FC<AuditLogButtonProps> = ({ endpoint, label, errorMessage }) => {
  const [loading, setLoading] = useState(false)
  const showBusy = useDelayedFlag(loading)

  const open = async (): Promise<void> => {
    setLoading(true)
    // Open the tab SYNCHRONOUSLY inside the click's user activation —
    // Safari blocks window.open after an await. Navigate it once the
    // short-lived link arrives; fall back to same-tab if a blocker ate it.
    const tab = window.open('', '_blank')
    try {
      const res = await fetch(endpoint, { method: 'POST' })
      if (!res.ok) throw new Error(String(res.status))
      const { link } = (await res.json()) as { link: string }
      if (tab) {
        tab.location.href = link
      } else {
        window.location.assign(link)
      }
    } catch {
      tab?.close()
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  return (
    // Busy is not disabled: it keeps the focus the press gave it, swallows a
    // second press, and swaps its glyph for the spinner only once the wait
    // has lasted 150 ms (same slot, so the label does not move).
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        if (!loading) void open()
      }}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      className="aria-disabled:cursor-default"
    >
      {showBusy ? (
        <Spinner size="xs" className="mr-1.5" />
      ) : (
        <ScrollText className="mr-1.5 size-3.5" aria-hidden />
      )}
      {label}
      <ExternalLink className="ml-1.5 size-3 text-muted-foreground" aria-hidden />
    </Button>
  )
}
