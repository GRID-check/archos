'use client'

import { useTranslations } from '@/i18n'
import type { PatchPreviewRow } from '@/lib/project-profile/patch-preview'

/**
 * The rows of a proposed change to the project profile: field, before, after.
 * They are DERIVED from the patch and the current profile (`buildPatchPreviewRows`),
 * never from a model-supplied preview, so what the reader consents to is exactly
 * what gets written. `showBefore` is false while the current profile is not
 * known, and once the change is applied (the profile then holds the „after“).
 */
export function ProfilePatchTable({ rows, showBefore }: { rows: readonly PatchPreviewRow[]; showBefore: boolean }) {
  const t = useTranslations('chat')
  if (rows.length === 0) return null
  return (
    <table className="w-full border-collapse text-sm" data-testid="profile-patch-rows">
      <thead>
        <tr className="border-b border-border text-muted-foreground">
          <th scope="col" className="py-1 pr-2 text-left font-medium">{t('profilePatchCard.field')}</th>
          {showBefore && <th scope="col" className="p-1 text-left font-medium">{t('profilePatchCard.before')}</th>}
          <th scope="col" className="pl-2 text-left font-medium">{t('profilePatchCard.after')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-border">
            <td className="py-1 pr-2 font-medium text-foreground">{row.label}</td>
            {showBefore && <td className="p-1 text-muted-foreground">{row.before}</td>}
            <td className="pl-2 text-foreground">{row.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
