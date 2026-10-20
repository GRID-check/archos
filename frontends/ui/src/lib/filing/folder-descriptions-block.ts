/**
 * `FOLDER_DESCRIPTIONS v1`: what a person wrote each folder holds, for the
 * agents (migration 0145). The agent's folder tree is the paths its inventory
 * reveals (`aiq_agent/tools/files/resolve.py`); this block puts the
 * descriptions beside them, so a chat that files a document, or says where
 * something belongs, files it the way the office described.
 *
 * It rides the memory channel (`composeMemoryContext`), which every turn, the
 * live per-turn digest and a background run already carry, so it reaches every
 * agent tier that receives the tree. The channel is read in every colleague's
 * chat, so only folders every member may read are listed: a project folder
 * under an own access list (ADR-0087, ADR-0088), or below one, is left out. A
 * description is a person's text, so it is masked like any chat text (ADR-0086)
 * and the block is bounded, and says so.
 */

import 'server-only'
import { folderTree, isUnderOwnList } from '@/lib/authz/folder-access-rule'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { formatBoundedDigest } from '@/lib/knowledge/digest-format'
import { maskChatText } from '@/lib/upload-screening/service'
import { listDescribedFolders } from './repository'

export const FOLDER_DESCRIPTIONS_HEADER = 'FOLDER_DESCRIPTIONS v1 (Ordner mit Beschreibung, gekürzt auf die ersten)'

/** The block's budget: a folder line is short, and the block is advice, not a listing. */
export const FOLDER_DESCRIPTIONS_MAX_CHARS = 1800

/** Longest description quoted on one line. */
const LINE_MAX_CHARS = 200

/** The shelf word in a line's tag: the agent's own vocabulary for the two shelves. */
const SHELF_TAG = { project: 'Projekt', office_shelf: 'Büroablage' } as const

/** The block, or null when no folder the channel may name has a description. */
export async function buildFolderDescriptionsBlock(
  organizationId: string,
  projectId: string | null
): Promise<string | null> {
  const [rows, tree] = await Promise.all([
    listDescribedFolders(organizationId, projectId),
    projectId ? listProjectFolderTree(organizationId, projectId).then(folderTree) : Promise.resolve(new Map()),
  ])
  const open = rows.filter((row) => row.scope === 'office_shelf' || !isUnderOwnList(tree, row.id))
  if (open.length === 0) return null
  const items = await Promise.all(
    open.map(async (row) => {
      const { text } = await maskChatText(organizationId, row.description)
      return {
        tags: [SHELF_TAG[row.scope], row.path],
        content: text.length > LINE_MAX_CHARS ? `${text.slice(0, LINE_MAX_CHARS - 1)}…` : text,
      }
    })
  )
  return formatBoundedDigest(FOLDER_DESCRIPTIONS_HEADER, items, FOLDER_DESCRIPTIONS_MAX_CHARS)
}
