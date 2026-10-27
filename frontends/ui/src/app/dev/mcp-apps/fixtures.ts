/**
 * The proposals and host styles the `/dev/mcp-apps` preview hands its frames.
 * Shapes are the route's own (`proposalResponseSchema`), so the view parses
 * them exactly as it parses `proposal-get`'s result on the door.
 */

import type { McpUiStyles } from '@modelcontextprotocol/ext-apps'
import type { ProposedChangeView } from '@/lib/proposals/types'

const BASE = {
  projectId: '3d1c2f7a-5b8e-4c1d-9f20-6a7b8c9d0e1f',
  status: 'proposed' as const,
  proposedByKind: 'piloti' as const,
  onBehalfOf: 'user_anna',
  onBehalfOfName: 'Anna Berger',
  originConversationId: null,
  originMessageId: null,
  createdAt: '2026-10-27T09:12:00.000Z',
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  results: null,
  canDecide: true,
}

export const OPERATION_PROPOSAL: ProposedChangeView = {
  ...BASE,
  id: '5f0c8a3e-2b7d-4e1a-9c6f-1d2e3f4a5b6c',
  kind: 'operation',
  payload: {
    operation: 'folder-rename',
    summary: 'Rename the folder „Pläne alt“ to „Archiv 2025“ in Wohnhaus Lindengasse',
    input: { params: { id: 'Wohnhaus Lindengasse', folderId: 'f-118' }, body: { name: 'Archiv 2025' } },
  },
  targets: [
    { type: 'project', id: '3d1c2f7a-5b8e-4c1d-9f20-6a7b8c9d0e1f', name: 'Wohnhaus Lindengasse' },
    { type: 'folder', id: 'f-118', name: 'Pläne alt' },
  ],
}

export const FILE_PROPOSAL: ProposedChangeView = {
  ...BASE,
  id: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  kind: 'file_operation',
  payload: {
    operation: 'move',
    operations: [
      { document: 'Grundriss EG.pdf', source: 'project', current: 'Nachweise', target_folder: 'Einreichung/Grundrisse' },
      { document: 'Schnitt A-A (Revision 3).pdf', source: 'project', current: 'Nachweise', target_folder: 'Einreichung/Schnitte' },
    ],
    note: 'Both were uploaded to „Nachweise“ by mistake.',
  },
}

export const READ_ONLY_PROPOSAL: ProposedChangeView = { ...OPERATION_PROPOSAL, id: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', canDecide: false }

/** A host's variables, as the SDK's reference host passes them (`examples/basic-host/src/host-styles.ts`, abridged). */
export const HOST_STYLES: McpUiStyles = {
  '--color-background-primary': 'light-dark(#ffffff, #262624)',
  '--color-background-secondary': 'light-dark(#f5f4ed, #30302e)',
  '--color-background-tertiary': 'light-dark(#f0eee6, #1f1e1d)',
  '--color-background-inverse': 'light-dark(#141413, #faf9f5)',
  '--color-text-primary': 'light-dark(#141413, #faf9f5)',
  '--color-text-secondary': 'light-dark(#5e5d59, #c2c0b6)',
  '--color-text-tertiary': 'light-dark(#87867f, #9c9a92)',
  '--color-text-inverse': 'light-dark(#faf9f5, #141413)',
  '--color-text-danger': 'light-dark(#b53333, #ff8f8f)',
  '--color-border-primary': 'light-dark(rgba(31,30,29,0.15), rgba(222,220,209,0.15))',
  '--color-border-secondary': 'light-dark(rgba(31,30,29,0.3), rgba(222,220,209,0.3))',
  '--color-ring-primary': 'light-dark(#2c84db, #5aa9f3)',
  '--font-sans': "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  '--border-radius-lg': '10px',
} as McpUiStyles
