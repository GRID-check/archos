/**
 * Org-wide Archiv, presented as a page sheet (ADR-0024).
 *
 * One component behind both arrivals: the intercepted overlay
 * (`(shell)/@overlay/(.)archiv`), where the sheet rises above whatever page
 * the reader is on, and the real `/app/archiv` page, where a hard load renders
 * the same sheet standing alone over the org chrome. Only `standalone` — what
 * "close" means — differs; see {@link RoutePageSheet}.
 *
 * Reachable by any org member, with uploads and deletes gated on
 * `org:archiv:manage`.
 *
 * Headerless on purpose: {@link OfficeShelfWorkspace} already opens with the gold
 * Büroablage identity row (mark, name, count, upload). A sheet header above it
 * would say "Archiv" twice, so the sheet's close control slots into that row
 * instead and the workspace's header is the sheet's one header.
 */

import type { JSX } from 'react'
import { withPageSession } from '@/lib/auth/require-auth'
import { canManageOfficeShelf } from '@/lib/authz/organizations'
import { isIfcModelsEnabled } from '@/lib/authz/feature-flags'
import { getTranslations } from '@/i18n/server'
import { PageSheetClose } from '@/components/ui/page-sheet'
import { RoutePageSheet } from '@/components/shell/route-page-sheet'
import { OfficeShelfWorkspace } from '@/features/documents/components/office-shelf-workspace'

export async function OfficeShelfSheet({ standalone }: { standalone: boolean }): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const t = await getTranslations('officeShelf')
    const tCommon = await getTranslations('common')
    const canManage = canManageOfficeShelf(session)
    // The same gate a project's Dateien reads, from the same helper. An `.ifc`
    // opened here has to behave the way an `.ifc` opened there behaves, and the
    // only way to guarantee that is for both surfaces to ask the same question
    // rather than each deciding locally.
    const showModels = isIfcModelsEnabled(session)

    return (
      <RoutePageSheet
        title={t('title')}
        subtitle={t('subtitle')}
        closeLabel={tCommon('actions.close')}
        headerless
        standalone={standalone}
      >
        <OfficeShelfWorkspace
          canManage={canManage}
          showModels={showModels}
          trailingActions={<PageSheetClose label={tCommon('actions.close')} />}
        />
      </RoutePageSheet>
    )
  })
}
