/**
 * Platform knowledge management — rename a base-corpus document (user-facing
 * display title). Platform owners only. Because retrieval is store-authoritative
 * for the display title, the change reflects on citation chips immediately with
 * no re-ingest. An empty/null title clears the override, restoring the default.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { updateKnowledgeBaseDisplayTitle } from '@/lib/knowledge/service'
import { knowledgeDisplayTitleSchema } from '@/lib/platform/platform-wire'

export const PATCH = platformApiRoute<{ fileName: string }>(
  async ({ request, params }) => {
    const { fileName } = params
    // A missing or unreadable body clears the override, as it always has.
    const body = knowledgeDisplayTitleSchema.safeParse(await request.json().catch(() => null))
    const raw = body.success ? (body.data.display_title ?? '').trim() : ''
    const displayTitle = raw || null

    await updateKnowledgeBaseDisplayTitle(fileName, displayTitle)
    return NextResponse.json({ fileName, displayTitle })
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
