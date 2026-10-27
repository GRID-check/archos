/**
 * Dev preview: Piloti's proposal card as an MCP App (ADR-0142), drawn by the
 * MCP Apps SDK's host side in sandboxed frames, the way Claude, ChatGPT or
 * VS Code draw it from a `proposal-get` result.
 *
 * The document is the built `ui://piloti/proposal-card` resource
 * (`mcp-app-views/proposal-card.html`, written by `bun run build:mcp-apps`,
 * which `dev:next` runs first). Judge per frame:
 *
 *  - **Host theme, light and dark**: the card takes the host's surface, text,
 *    border, radius and font where the host gives them, and keeps Piloti's
 *    layout, copy and its one ink action.
 *  - **No host styles**: Piloti's own tokens, unchanged.
 *  - **German host**: the host's locale picks the copy.
 *  - **Read only**: no buttons, and the line that says why.
 *  - Pressing Apply or Discard: the frame's log shows the app-only tool the
 *    card called and the context line the model is told afterwards.
 *
 * A Server Component: it reads the built file; 404s outside development (the
 * `/dev` layout).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { McpAppsPreview } from './preview'

async function viewDocument(): Promise<string | null> {
  try {
    return await readFile(join(process.cwd(), 'mcp-app-views', 'proposal-card.html'), 'utf8')
  } catch {
    return null
  }
}

export default async function McpAppsPreviewPage() {
  const html = await viewDocument()
  if (!html) {
    return (
      <main className="p-8 text-sm">
        The view is not built. Run <code>bun run build:mcp-apps</code> in <code>frontends/ui</code>.
      </main>
    )
  }
  return <McpAppsPreview html={html} />
}
